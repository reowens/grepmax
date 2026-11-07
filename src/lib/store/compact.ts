import { createHash, type Hash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Data, RecordBatch, Schema } from "apache-arrow";
import { DISK_CRITICAL_BYTES } from "../../config";
import * as lancedb from "./lance-sdk";
import {
  assertStoreMutationAllowed,
  availableStoreDiskBytes,
} from "./maintenance-policy";
import { StoreLease, StoreLeaseTimeoutError } from "./store-lease";

const TABLE_NAME = "chunks";
const INDEXES = ["content_idx", "path_idx"];
// Bounded reclamation skips any fragment over 32 MiB or 32,768 live rows, so
// every output fragment must stay under both for later deletions to be merged.
export const MAX_FRAGMENT_BYTES = 32 * 1024 * 1024;
export const MAX_FRAGMENT_ROWS = 32_768;
const FRAGMENT_ROW_TARGET = 8192;
export const DEFAULT_FRAGMENT_TARGET_BYTES = 16 * 1024 * 1024;

export interface CompactRequest {
  store: string;
  once?: boolean;
  targetBytes?: number;
  leaseTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface TableShape {
  version: number;
  rows: number;
  deletedRows: number;
  fragments: number;
  bytes: number;
}

export interface CompactReport {
  outcome: "compacted";
  store: string;
  before: TableShape;
  after: TableShape & {
    maxFragmentRows: number;
    maxFragmentBytes: number;
    unindexedRows: Record<string, number>;
  };
  fragmentsWritten: number;
  timingsMs: { rewrite: number; indexes: number; verify: number };
  oldVersions: "kept";
}

function localStore(input: string): string {
  const store = path.resolve(input);
  const table = path.join(store, `${TABLE_NAME}.lance`);
  for (const dir of [store, table]) {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        `Compaction needs a local store directory holding ${TABLE_NAME}.lance: ${dir}`,
      );
  }
  return fs.realpathSync(store);
}

function treeBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += treeBytes(full);
    else if (entry.isFile()) total += fs.lstatSync(full).size;
  }
  return total;
}

function dataBytes(data: Data): number {
  let total = 0;
  for (const buffer of Object.values(data.buffers))
    if (buffer) total += (buffer as ArrayBufferView).byteLength;
  for (const child of data.children) total += dataBytes(child);
  return total;
}

function feed(hash: Hash, value: unknown): void {
  if (value === null || value === undefined) {
    hash.update("\u0000");
  } else if (ArrayBuffer.isView(value)) {
    hash.update(`b${value.byteLength}:`);
    hash.update(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  } else if (
    typeof value === "object" &&
    typeof (value as { toArray?: unknown }).toArray === "function"
  ) {
    const items = (value as { toArray(): unknown }).toArray();
    if (ArrayBuffer.isView(items)) {
      feed(hash, items);
      return;
    }
    const list = items as unknown[];
    hash.update(`l${list.length}:`);
    for (const item of list) feed(hash, item);
  } else {
    const text = String(value);
    hash.update(`${typeof value}${text.length}:`);
    hash.update(text);
  }
}

/** One `id<TAB>sha256` entry per row over every column, sorted by the caller. */
function rowDigests(batch: RecordBatch, out: string[]): void {
  const columns = batch.schema.fields.map((_, i) => batch.getChildAt(i)!);
  const ids = batch.getChild("id");
  if (!ids) throw new Error("Compaction requires an id column");
  for (let row = 0; row < batch.numRows; row++) {
    const hash = createHash("sha256");
    for (const column of columns) feed(hash, column.get(row));
    out.push(`${ids.get(row)}\t${hash.digest("hex")}`);
  }
}

function schemaSignature(schema: Schema): string {
  return JSON.stringify({
    fields: schema.fields.map((f) => [
      f.name,
      String(f.type),
      f.nullable,
      [...f.metadata],
    ]),
    metadata: [...schema.metadata],
  });
}

async function shape(table: lancedb.Table, dir: string): Promise<TableShape> {
  const stats = await table.stats();
  return {
    version: await table.version(),
    rows: stats.numRows,
    deletedRows: stats.numDeletedRows ?? 0,
    fragments: stats.fragmentStats.numFragments,
    bytes: treeBytes(dir),
  };
}

async function digestsOf(table: lancedb.Table, signal?: AbortSignal) {
  const out: string[] = [];
  for await (const batch of table.query()) {
    signal?.throwIfAborted();
    rowDigests(batch, out);
  }
  return out.sort();
}

/** The one supervised compaction past full-table containment. It rewrites the
 * live rows of `<store>/chunks.lance` into bounded fragments under an exclusive
 * store lease, rebuilds both scalar indexes and verifies every row before it
 * returns. On a failed verification the source version is restored as head.
 * Old versions are kept; the daemon's version cleanup prunes them. */
export async function compactStore(
  request: CompactRequest,
): Promise<CompactReport> {
  if (!request.once)
    throw new Error("gmax compact runs only as a supervised --once run");
  request.signal?.throwIfAborted();
  const store = localStore(request.store);
  const tableDir = path.join(store, `${TABLE_NAME}.lance`);
  const targetBytes = request.targetBytes ?? DEFAULT_FRAGMENT_TARGET_BYTES;
  if (
    !Number.isFinite(targetBytes) ||
    targetBytes < 1 ||
    targetBytes > MAX_FRAGMENT_BYTES
  )
    throw new Error(
      `Fragment target must be between 1 byte and ${MAX_FRAGMENT_BYTES} bytes`,
    );
  assertStoreMutationAllowed();
  const required = treeBytes(tableDir) + DISK_CRITICAL_BYTES;
  const available = availableStoreDiskBytes(store);
  if (!(available >= required))
    throw new Error(
      `Compaction needs ${required} bytes free (the table plus the disk floor); ${Number.isFinite(available) ? available : "unknown"} available`,
    );
  let lease: StoreLease;
  try {
    lease = await StoreLease.acquireExclusive({
      storeDir: store,
      timeoutMs: request.leaseTimeoutMs ?? 1000,
      signal: request.signal,
      role: "explicit-compact",
    });
  } catch (error) {
    if (error instanceof StoreLeaseTimeoutError) {
      const owners = error.blockers
        .map((b) => `${b.role} pid ${b.pid}`)
        .join(", ");
      throw new Error(
        `Store is held by a daemon or another writer${owners ? ` (${owners})` : ""}; stop them before compacting`,
      );
    }
    throw error;
  }
  try {
    return await lease.withExclusiveUse(store, () =>
      rewrite(store, tableDir, targetBytes, request.signal),
    );
  } finally {
    await lease.release();
  }
}

async function rewrite(
  store: string,
  tableDir: string,
  targetBytes: number,
  signal?: AbortSignal,
): Promise<CompactReport> {
  const db = await lancedb.connect(store);
  const head = await db.openTable(TABLE_NAME);
  const source = await db.openTable(TABLE_NAME);
  try {
    const unknown = (await head.listIndices())
      .map((i) => i.name)
      .filter((name) => !INDEXES.includes(name));
    if (unknown.length > 0)
      throw new Error(
        `Compaction rebuilds only ${INDEXES.join(" and ")}; found ${unknown.join(", ")}`,
      );
    const before = await shape(head, tableDir);
    if (before.rows === 0) throw new Error("Table has no live rows to keep");
    await source.checkout(before.version);
    const schema = await source.schema();
    const dataDir = path.join(tableDir, "data");
    const existingFiles = new Set(fs.readdirSync(dataDir));

    let restoreNeeded = false;
    try {
      const started = Date.now();
      const sourceDigests: string[] = [];
      let pending: RecordBatch[] = [];
      let pendingBytes = 0;
      let pendingRows = 0;
      let fragmentsWritten = 0;
      const flush = async () => {
        if (pending.length === 0) return;
        restoreNeeded = true;
        // Batches come from the SDK's own Arrow copy, so pass them table-like
        // instead of through this package's Table class.
        const data = { schema: pending[0].schema, batches: pending };
        await head.add(data as unknown as Parameters<lancedb.Table["add"]>[0], {
          mode: fragmentsWritten === 0 ? "overwrite" : "append",
        });
        fragmentsWritten++;
        pending = [];
        pendingBytes = 0;
        pendingRows = 0;
      };
      for await (const batch of source.query()) {
        signal?.throwIfAborted();
        if (batch.numRows === 0) continue;
        rowDigests(batch, sourceDigests);
        const rowBytes = dataBytes(batch.data) / batch.numRows;
        const step = Math.max(
          1,
          Math.min(FRAGMENT_ROW_TARGET, Math.floor(targetBytes / rowBytes)),
        );
        for (let offset = 0; offset < batch.numRows; offset += step) {
          const slice = batch.slice(offset, offset + step);
          const bytes = slice.numRows * rowBytes;
          if (
            pending.length > 0 &&
            (pendingBytes + bytes > targetBytes ||
              pendingRows + slice.numRows > FRAGMENT_ROW_TARGET)
          )
            await flush();
          pending.push(slice);
          pendingBytes += bytes;
          pendingRows += slice.numRows;
        }
      }
      await flush();
      const rewriteMs = Date.now() - started;

      const indexStarted = Date.now();
      await head.createIndex("content", {
        config: lancedb.Index.fts({ withPosition: true }),
        name: "content_idx",
        replace: true,
      });
      await head.createIndex("path", {
        config: lancedb.Index.btree(),
        name: "path_idx",
        replace: true,
      });
      const indexMs = Date.now() - indexStarted;

      const verifyStarted = Date.now();
      const after = await shape(head, tableDir);
      const stats = await head.stats();
      const newFiles = fs
        .readdirSync(dataDir)
        .filter((name) => !existingFiles.has(name));
      const maxFragmentBytes = Math.max(
        0,
        ...newFiles.map((name) => fs.lstatSync(path.join(dataDir, name)).size),
      );
      const maxFragmentRows = stats.fragmentStats.lengths.max;
      const unindexedRows: Record<string, number> = {};
      for (const name of INDEXES) {
        const index = await head.indexStats(name);
        unindexedRows[name] = index ? index.numUnindexedRows : Number.NaN;
      }
      const problems: string[] = [];
      if (after.rows !== before.rows)
        problems.push(`live rows ${after.rows}, expected ${before.rows}`);
      if (after.deletedRows !== 0)
        problems.push(`${after.deletedRows} deleted rows remain`);
      if (after.fragments !== fragmentsWritten)
        problems.push(
          `${after.fragments} fragments, expected ${fragmentsWritten}`,
        );
      if (newFiles.length !== fragmentsWritten)
        problems.push(
          `${newFiles.length} new data files, expected ${fragmentsWritten}`,
        );
      if (maxFragmentBytes > MAX_FRAGMENT_BYTES)
        problems.push(`a data file has ${maxFragmentBytes} bytes`);
      if (maxFragmentRows > MAX_FRAGMENT_ROWS)
        problems.push(`a fragment has ${maxFragmentRows} rows`);
      for (const [name, rows] of Object.entries(unindexedRows))
        if (rows !== 0) problems.push(`${name} leaves ${rows} rows unindexed`);
      if (schemaSignature(await head.schema()) !== schemaSignature(schema))
        problems.push("schema changed");
      if (problems.length === 0) {
        const resultDigests = await digestsOf(head, signal);
        sourceDigests.sort();
        if (
          resultDigests.length !== sourceDigests.length ||
          resultDigests.some((entry, i) => entry !== sourceDigests[i])
        )
          problems.push("row ids or values differ from the source version");
      }
      if (problems.length > 0)
        throw new Error(
          `Compacted table failed verification: ${problems.join("; ")}`,
        );
      return {
        outcome: "compacted",
        store,
        before,
        after: { ...after, maxFragmentRows, maxFragmentBytes, unindexedRows },
        fragmentsWritten,
        timingsMs: {
          rewrite: rewriteMs,
          indexes: indexMs,
          verify: Date.now() - verifyStarted,
        },
        oldVersions: "kept",
      };
    } catch (error) {
      if (!restoreNeeded) throw error;
      const message = error instanceof Error ? error.message : String(error);
      try {
        await source.restore();
      } catch (restoreError) {
        throw new Error(
          `${message}; restoring source version ${before.version} also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
      throw new Error(
        `${message}; source version ${before.version} restored as head`,
      );
    }
  } finally {
    head.close();
    source.close();
  }
}
