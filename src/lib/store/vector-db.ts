import * as fs from "node:fs";
import * as lancedb from "@lancedb/lancedb";
import {
  Binary,
  Bool,
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Int32,
  List,
  Schema,
  Utf8,
} from "apache-arrow";
import {
  CONFIG,
  DISK_CRITICAL_BYTES,
  DISK_LOW_BYTES,
  FRAGMENT_COMPACT_THRESHOLD,
} from "../../config";
import { readGlobalConfig } from "../index/index-config";
import { registerCleanup } from "../utils/cleanup";
import { escapeSqlString, pathStartsWith } from "../utils/filter-builder";
import { debug, log, timer } from "../utils/logger";
import { StoreLease } from "./store-lease";
import type { VectorRecord } from "./types";

export type DiskPressureLevel = "ok" | "low" | "critical";

export class DiskPressureError extends Error {
  constructor(message = "Disk critically low — writes suspended") {
    super(message);
    this.name = "DiskPressureError";
  }
}

/**
 * Detects "Not found: <hash>.lance" errors from LanceDB — these indicate the
 * manifest references a fragment file that doesn't exist on disk, typically
 * caused by an interrupted compaction. Recovery requires `gmax index --reset`.
 */
export function isLanceCorruptionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Not found:.*\.lance(?:[^a-z]|$)/i.test(msg);
}

export function isMissingTableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EIO") return false;
  const msg = err instanceof Error ? err.message : String(err);
  const tableMissing =
    /table.*chunks.*(?:not found|does not exist)/i.test(msg) ||
    /(?:not found|does not exist).*table.*chunks/i.test(msg) ||
    /no such table.*chunks/i.test(msg);
  if (tableMissing) return true;
  if (isLanceCorruptionError(err)) return false;
  return false;
}

const TABLE_NAME = "chunks";

const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

export class VectorDB {
  private db: lancedb.Connection | null = null;
  private unregisterCleanup?: () => void;
  private closed = false;
  private readonly vectorDim: number;
  private maintenanceRunning = false;
  private maintenancePromise: Promise<void> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceRunner: (fn: () => Promise<void>) => Promise<void> = (
    fn,
  ) => fn();
  private lastCorruptionLogMs = 0;
  diskPressure: DiskPressureLevel = "ok";
  private lastDiskCheckMs = 0;
  private lastLoggedPressure: DiskPressureLevel = "ok";
  private static readonly DISK_CHECK_INTERVAL_MS = 30_000;
  private leasePromise: Promise<StoreLease> | null = null;
  private readonly leaseAbort = new AbortController();
  private closePromise: Promise<void> | null = null;
  private releaseLeaseOnClose = true;
  private requireClosedOnClose = false;
  private leaseTransitionTail: Promise<void> = Promise.resolve();
  private readonly leaseHolder = {};

  // Write gate: async read-write lock where writes are "readers" (shared)
  // and compaction is the "writer" (exclusive).
  private activeWrites = 0;
  private readonly writeDrainResolvers = new Set<() => void>();
  private compactingPromise: Promise<void> | null = null;
  private exclusiveMutationPromise: Promise<void> | null = null;
  private activeCompactions = 0;
  private readonly compactionDrainResolvers = new Set<() => void>();

  constructor(
    private lancedbDir: string,
    vectorDim?: number,
    private readonly suppliedLease?: StoreLease,
  ) {
    // Default to the configured tier's dim (not the hard-wired small-tier 384)
    // so a `standard`-tier index actually stores 768d vectors. An explicit
    // arg still wins (eval scripts, tests).
    this.vectorDim = vectorDim ?? readGlobalConfig().vectorDim;
    this.unregisterCleanup = registerCleanup(() => this.close());
  }

  /**
   * Start a periodic maintenance timer (FTS rebuild + optimize).
   * Call once from the daemon — replaces per-processor maintenance intervals.
   */
  startMaintenanceLoop(
    runOperation?: (fn: () => Promise<void>) => Promise<void>,
  ): void {
    if (runOperation) this.maintenanceRunner = runOperation;
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      if (this.closed) return;
      // Skip if a previous tick is still running so close() has a single
      // promise to await instead of a chain.
      if (this.maintenancePromise) return;
      const run = this.maintenanceRunner(async () => {
        try {
          await this.runMaintenance();
        } catch (err) {
          // Suppress the expected close-race error so it stops polluting logs.
          // close() awaits maintenancePromise, but the timer can fire and start
          // a tick microseconds before shutdown sets `closed`, in which case
          // getDb() throws after we've nulled `db`.
          const msg = err instanceof Error ? err.message : String(err);
          if (this.closed && msg.includes("VectorDB connection is closed"))
            return;
          if (isLanceCorruptionError(err)) {
            // Log once per hour at most — repeating this every 5 min is just noise.
            const now = Date.now();
            if (now - this.lastCorruptionLogMs > 60 * 60 * 1000) {
              this.lastCorruptionLogMs = now;
              log(
                "vectordb",
                `CORRUPTION: LanceDB manifest references a missing fragment file. ` +
                  `This is usually caused by an interrupted compaction. ` +
                  `To repair, run: gmax index --reset (per-project). Original: ${msg}`,
              );
            }
            return;
          }
          log("vectordb", `Periodic maintenance failed: ${err}`);
        }
      });
      this.maintenancePromise = run.finally(() => {
        if (this.maintenancePromise === run) this.maintenancePromise = null;
      });
    }, MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref();
  }

  /** True iff a maintenance tick is currently running. Used by the daemon to
   *  defer idle shutdown so we don't tear down LanceDB mid-optimize. */
  isMaintenanceActive(): boolean {
    return this.maintenancePromise !== null;
  }

  /** Pause the maintenance timer (e.g. during a full index that calls runMaintenance itself). */
  pauseMaintenanceLoop(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
  }

  /** Resume the maintenance timer after a pause. */
  resumeMaintenanceLoop(): void {
    this.startMaintenanceLoop();
  }

  private async getDb(): Promise<lancedb.Connection> {
    if (this.closed) {
      throw new Error("VectorDB connection is closed");
    }
    await this.getLease();
    if (this.closed) {
      throw new Error("VectorDB connection is closed");
    }
    if (!this.db) {
      fs.mkdirSync(this.lancedbDir, { recursive: true });
      this.db = await lancedb.connect(this.lancedbDir);
    }
    return this.db;
  }

  private getLease(): Promise<StoreLease> {
    if (!this.leasePromise) {
      const lease = this.suppliedLease
        ? Promise.resolve(this.suppliedLease)
        : StoreLease.acquireShared({
            storeDir: this.lancedbDir,
            role: process.title || "gmax",
            signal: this.leaseAbort.signal,
          });
      this.leasePromise = lease.then((resolved) => {
        resolved.claim(this.leaseHolder, this.lancedbDir);
        return resolved;
      });
    }
    return this.leasePromise;
  }

  private async withLeaseTransition<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.leaseTransitionTail;
    let release!: () => void;
    this.leaseTransitionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Upgrade and retain this instance's current lease for transfer to a new DB. */
  async upgradeStoreLease(signal?: AbortSignal): Promise<StoreLease> {
    if (this.closed) throw new Error("VectorDB connection is closed");
    if (this.exclusiveMutationPromise) await this.exclusiveMutationPromise;
    return this.withLeaseTransition(async () => {
      const current = await this.getLease();
      if (current.mode === "exclusive") return current;
      const upgrade = current.upgrade({ signal });
      this.leasePromise = upgrade;
      try {
        const upgraded = await upgrade;
        upgraded.claim(this.leaseHolder, this.lancedbDir);
        return upgraded;
      } catch (error) {
        this.leasePromise = Promise.resolve(current);
        throw error;
      }
    });
  }

  /** Downgrade a transferred exclusive lease and retain the replacement token. */
  async downgradeStoreLease(): Promise<StoreLease> {
    if (this.closed) throw new Error("VectorDB connection is closed");
    if (this.exclusiveMutationPromise) await this.exclusiveMutationPromise;
    return this.withLeaseTransition(async () => {
      const current = await this.getLease();
      if (current.mode === "shared") return current;
      const downgrade = current.downgrade();
      this.leasePromise = downgrade;
      try {
        const downgraded = await downgrade;
        downgraded.claim(this.leaseHolder, this.lancedbDir);
        return downgraded;
      } catch (error) {
        this.leasePromise = Promise.resolve(current);
        throw error;
      }
    });
  }

  getAvailableBytes(): number {
    try {
      const stats = fs.statfsSync(this.lancedbDir);
      return stats.bavail * stats.bsize;
    } catch {
      return Number.MAX_SAFE_INTEGER; // fail-open
    }
  }

  checkDiskPressure(): DiskPressureLevel {
    const now = Date.now();
    if (now - this.lastDiskCheckMs < VectorDB.DISK_CHECK_INTERVAL_MS) {
      return this.diskPressure;
    }
    this.lastDiskCheckMs = now;

    const avail = this.getAvailableBytes();
    let level: DiskPressureLevel;
    if (avail < DISK_CRITICAL_BYTES) {
      level = "critical";
    } else if (avail < DISK_LOW_BYTES) {
      level = "low";
    } else {
      level = "ok";
    }

    if (level !== this.lastLoggedPressure) {
      const freeStr = `${(avail / 1024 / 1024 / 1024).toFixed(1)}GB`;
      if (level === "critical") {
        log(
          "vectordb",
          `CRITICAL: disk space critically low (${freeStr} free) — writes suspended`,
        );
      } else if (level === "low") {
        log(
          "vectordb",
          `WARNING: disk space low (${freeStr} free) — compaction limited`,
        );
      } else if (this.lastLoggedPressure !== "ok") {
        log(
          "vectordb",
          `Disk pressure resolved (${freeStr} free) — writes resuming`,
        );
      }
      this.lastLoggedPressure = level;
    }

    this.diskPressure = level;
    return level;
  }

  private ensureDiskOk(): void {
    if (this.checkDiskPressure() === "critical") {
      throw new DiskPressureError();
    }
  }

  /**
   * Wrap a write operation so it coordinates with compaction.
   * Multiple writes can proceed concurrently (shared access),
   * but all writes pause when compaction wants exclusive access.
   */
  private async withWriteGate<T>(fn: () => Promise<T>): Promise<T> {
    while (this.exclusiveMutationPromise || this.compactingPromise) {
      if (this.closed) throw new Error("VectorDB connection is closed");
      await Promise.all(
        [this.exclusiveMutationPromise, this.compactingPromise].filter(
          (promise): promise is Promise<void> => promise !== null,
        ),
      );
    }
    if (this.closed) throw new Error("VectorDB connection is closed");
    this.activeWrites++;
    try {
      return await fn();
    } finally {
      this.activeWrites--;
      if (this.activeWrites === 0) {
        for (const resolve of this.writeDrainResolvers) resolve();
        this.writeDrainResolvers.clear();
      }
    }
  }

  private drainCompactions(): Promise<void> {
    if (this.activeCompactions === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.compactionDrainResolvers.add(resolve);
    });
  }

  /**
   * Run a destructive table mutation while holding the process-wide exclusive
   * store intent. New local writes stop before existing activity is drained.
   */
  async withExclusiveTableMutation<T>(
    mutation: (db: lancedb.Connection) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error("VectorDB connection is closed");
    if (this.exclusiveMutationPromise) {
      throw new Error("An exclusive table mutation is already in progress");
    }

    let resolveMutation!: () => void;
    this.exclusiveMutationPromise = new Promise<void>((resolve) => {
      resolveMutation = resolve;
    });
    try {
      return await this.withLeaseTransition(async () => {
        let temporaryExclusiveLease: StoreLease | null = null;
        try {
          const currentLease = await this.getLease();
          if (currentLease.mode === "shared") {
            temporaryExclusiveLease = await StoreLease.acquireExclusive({
              storeDir: this.lancedbDir,
              pid: currentLease.owner.pid,
              processStart: currentLease.owner.processStart,
              role: `${currentLease.owner.role}:exclusive-mutation`,
              ignoreNonces: new Set([currentLease.owner.nonce]),
              signal: this.leaseAbort.signal,
            });
          }
          await Promise.all([this.drainWrites(), this.drainCompactions()]);
          const db = await this.getDb();
          return await mutation(db);
        } finally {
          await temporaryExclusiveLease?.release();
        }
      });
    } finally {
      this.exclusiveMutationPromise = null;
      resolveMutation();
    }
  }

  /** Wait for all in-flight writes to complete before compaction. */
  private drainWrites(): Promise<void> {
    if (this.activeWrites === 0) return Promise.resolve();
    debug(
      "vectordb",
      `Draining ${this.activeWrites} in-flight write(s) before compaction`,
    );
    return new Promise<void>((resolve) => {
      this.writeDrainResolvers.add(resolve);
    });
  }

  private seedRow(): VectorRecord {
    return {
      id: "seed",
      path: "",
      hash: "",
      content: "",
      display_text: "",
      start_line: 0,
      end_line: 0,
      chunk_index: 0,
      is_anchor: false,
      context_prev: "",
      context_next: "",
      chunk_type: "",
      complexity: 0,
      is_exported: false,
      vector: Array(this.vectorDim).fill(0),
      colbert: Buffer.alloc(0),
      colbert_scale: 1,
      pooled_colbert_48d: Array(CONFIG.COLBERT_DIM).fill(0),
      doc_token_ids: [],
      defined_symbols: [],
      referenced_symbols: [],
      type_referenced_symbols: [],
      member_referenced_symbols: [],
      imports: [],
      exports: [],
      role: "",
      parent_symbol: "",
      file_skeleton: "",
      summary: "",
    };
  }

  /**
   * Read the physical width of the on-disk `vector` column, or null if the
   * table doesn't exist yet. Non-throwing and validation-free on purpose: doctor
   * uses it to detect a table stranded at an old width after a tier change, and
   * must see the truth even when the table is incompatible with the current
   * config (a throwing ensureTable would mask exactly the mismatch we're hunting).
   */
  async getSchemaVectorDim(): Promise<number | null> {
    const db = await this.getDb();
    let table: lancedb.Table;
    try {
      table = await db.openTable(TABLE_NAME);
    } catch (err) {
      if (isMissingTableError(err)) return null;
      throw err;
    }
    const schema = await table.schema();
    const field = schema.fields.find((f) => f.name === "vector");
    if (!field) return null;
    // The `vector` column is a FixedSizeList; its listSize is the vector width.
    const listSize = (field.type as { listSize?: number }).listSize;
    return typeof listSize === "number" ? listSize : null;
  }

  private async validateSchema(table: lancedb.Table) {
    const schema = await table.schema();
    const fields = new Set(schema.fields.map((f) => f.name));
    const required = ["complexity", "is_exported"];
    const missing = required.filter((r) => !fields.has(r));
    if (missing.length > 0) {
      throw new Error(
        `[vector-db] schema missing fields (${missing.join(
          ", ",
        )}). Please run "gmax index --reset" to rebuild the index.`,
      );
    }
  }

  private buildSchema(): Schema {
    return new Schema([
      new Field("id", new Utf8(), false),
      new Field("path", new Utf8(), false),
      new Field("hash", new Utf8(), false),
      new Field("content", new Utf8(), false),
      new Field("display_text", new Utf8(), false),
      new Field("start_line", new Int32(), false),
      new Field("end_line", new Int32(), false),
      new Field(
        "vector",
        new FixedSizeList(
          this.vectorDim,
          new Field("item", new Float32(), false),
        ),
        false,
      ),
      new Field("chunk_index", new Int32(), true),
      new Field("is_anchor", new Bool(), true),
      new Field("context_prev", new Utf8(), true),
      new Field("context_next", new Utf8(), true),
      new Field("chunk_type", new Utf8(), true),
      new Field("complexity", new Float32(), true),
      new Field("is_exported", new Bool(), true),
      new Field("colbert", new Binary(), true),
      new Field("colbert_scale", new Float64(), true),
      new Field(
        "pooled_colbert_48d",
        new FixedSizeList(
          CONFIG.COLBERT_DIM,
          new Field("item", new Float32(), false),
        ),
        true,
      ),
      new Field(
        "doc_token_ids",
        new List(new Field("item", new Int32(), true)),
        true,
      ),
      new Field(
        "defined_symbols",
        new List(new Field("item", new Utf8(), true)),
        true,
      ),
      new Field(
        "referenced_symbols",
        new List(new Field("item", new Utf8(), true)),
        true,
      ),
      new Field(
        "type_referenced_symbols",
        new List(new Field("item", new Utf8(), true)),
        true,
      ),
      new Field(
        "member_referenced_symbols",
        new List(new Field("item", new Utf8(), true)),
        true,
      ),
      new Field("imports", new List(new Field("item", new Utf8(), true)), true),
      new Field("exports", new List(new Field("item", new Utf8(), true)), true),
      new Field("role", new Utf8(), true),
      new Field("parent_symbol", new Utf8(), true),
      new Field("file_skeleton", new Utf8(), true),
      new Field("summary", new Utf8(), true),
    ]);
  }

  /**
   * In-place, non-breaking schema evolution for additive list columns. Older
   * tables predate `type_referenced_symbols`; adding it via `addColumns` (rather
   * than forcing `gmax index --reset`) keeps a live daemon's incremental writes
   * working — existing rows read back as empty until their file is reindexed,
   * which is when the new edges would populate anyway. Idempotent: re-adding an
   * existing column throws, which we swallow.
   */
  private async evolveSchema(table: lancedb.Table): Promise<void> {
    const schema = await table.schema();
    const fields = new Set(schema.fields.map((f) => f.name));
    // Additive list columns that older tables may predate. Each is checked and
    // added INDEPENDENTLY: a single early-return on the first existing column
    // (as this used to do) would permanently strand every table that already has
    // `type_referenced_symbols` — i.e. all of them — without ever gaining a newer
    // column like `member_referenced_symbols`.
    const additiveListColumns = [
      "type_referenced_symbols",
      "member_referenced_symbols",
    ];
    for (const col of additiveListColumns) {
      if (fields.has(col)) continue;
      try {
        await table.addColumns(
          new Field(col, new List(new Field("item", new Utf8(), true)), true),
        );
        log("db", `Added ${col} column to existing table`);
      } catch (err) {
        // Lost a race with another writer that already added it, or a transient
        // commit conflict — the next ensureTable() re-checks and no-ops.
        debug(
          "vectordb",
          `evolveSchema ${col} skipped: ${(err as Error).message}`,
        );
      }
    }
  }

  async ensureTable(): Promise<lancedb.Table> {
    return this.withWriteGate(() => this.ensureTableUnsafe());
  }

  private async ensureTableUnsafe(): Promise<lancedb.Table> {
    const db = await this.getDb();
    let table: lancedb.Table;
    try {
      table = await db.openTable(TABLE_NAME);
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      log("db", `Creating table (${this.vectorDim}d)`);
      const schema = this.buildSchema();
      table = await db.createTable(TABLE_NAME, [this.seedRow()], {
        schema,
      });
      await table.delete('id = "seed"');
      return table;
    }

    await this.validateSchema(table);
    await this.evolveSchema(table);
    return table;
  }

  async insertBatch(records: VectorRecord[]): Promise<void> {
    if (!records.length) return;
    this.ensureDiskOk();
    const toBuffer = (val: unknown): Buffer => {
      if (Buffer.isBuffer(val)) return val;
      if (ArrayBuffer.isView(val) && (val as ArrayBufferView).buffer) {
        const view = val as ArrayBufferView;
        return Buffer.from(
          view.buffer,
          view.byteOffset ?? 0,
          view.byteLength ?? undefined,
        );
      }
      if (
        val &&
        typeof val === "object" &&
        "type" in (val as any) &&
        (val as any).type === "Buffer" &&
        Array.isArray((val as any).data)
      ) {
        return Buffer.from((val as any).data);
      }
      if (Array.isArray(val)) return Buffer.from(val);
      return Buffer.alloc(0);
    };

    const toNumberArray = (val: unknown): number[] => {
      if (Array.isArray(val)) return val.map((x) => Number(x) || 0);
      if (ArrayBuffer.isView(val) && (val as ArrayBufferView).buffer) {
        return Array.from(val as unknown as ArrayLike<number>);
      }
      if (
        val &&
        typeof val === "object" &&
        !("length" in (val as any)) &&
        Object.keys(val as any).length > 0
      ) {
        // Plain object with numeric keys (e.g., from IPC serialization)
        return Object.entries(val as Record<string, unknown>)
          .filter(([k]) => !Number.isNaN(Number(k)))
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([, v]) => Number(v) || 0);
      }
      return [];
    };

    // Mutate records in-place to avoid doubling memory with a parallel rows array.
    // Callers (syncer flushBatch) splice records before passing — they're never reused.
    for (const rec of records) {
      const vec = toNumberArray(rec.vector);
      // Never silently pad/truncate: a width mismatch means the embedding tier
      // and this table disagree (wrong model wired, or a stale index after a
      // tier change). Reshaping would store garbage that scores meaninglessly.
      // Fail loudly and point at the fix instead.
      if (vec.length !== this.vectorDim) {
        throw new Error(
          `Vector dimension mismatch: got ${vec.length}d, expected ${this.vectorDim}d. ` +
            "The embedding model tier likely changed without a rebuild — the shared " +
            "table is fixed-width. Run `gmax repair --rebuild` to rebuild the whole corpus.",
        );
      }
      (rec as any).vector = vec;
      (rec as any).colbert = toBuffer(rec.colbert);
      (rec as any).display_text = "";
      (rec as any).chunk_index = rec.chunk_index ?? null;
      (rec as any).is_anchor = rec.is_anchor ?? false;
      (rec as any).context_prev = rec.context_prev ?? "";
      (rec as any).context_next = rec.context_next ?? "";
      (rec as any).chunk_type = rec.chunk_type ?? "";
      (rec as any).complexity =
        typeof rec.complexity === "number" ? rec.complexity : undefined;
      (rec as any).is_exported = rec.is_exported ?? false;
      (rec as any).colbert_scale =
        typeof rec.colbert_scale === "number" ? rec.colbert_scale : 1;
      (rec as any).pooled_colbert_48d = rec.pooled_colbert_48d
        ? Array.from(rec.pooled_colbert_48d)
        : undefined;
      (rec as any).doc_token_ids = rec.doc_token_ids
        ? Array.from(rec.doc_token_ids)
        : null;
      (rec as any).defined_symbols = rec.defined_symbols ?? [];
      (rec as any).referenced_symbols = rec.referenced_symbols ?? [];
      (rec as any).type_referenced_symbols = rec.type_referenced_symbols ?? [];
      (rec as any).member_referenced_symbols =
        rec.member_referenced_symbols ?? [];
      (rec as any).imports = rec.imports ?? [];
      (rec as any).exports = rec.exports ?? [];
      (rec as any).role = rec.role ?? "";
      (rec as any).parent_symbol = rec.parent_symbol ?? "";
      (rec as any).file_skeleton = rec.file_skeleton ?? "";
      (rec as any).summary = rec.summary ?? null;
    }

    try {
      await this.withWriteGate(async () => {
        const table = await this.ensureTableUnsafe();
        await table.add(records);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("found field not in schema")) {
        const table = await this.ensureTable();
        const schema = await table.schema();
        const schemaFields = schema.fields.map((f) => f.name);
        throw new Error(
          `[vector-db] schema mismatch detected (fields: ${schemaFields.join(
            ", ",
          )}). Please run "gmax index --reset" to rebuild the index.`,
        );
      }
      throw err;
    }
  }

  async createFTSIndex(rebuild = false, retries = 5): Promise<void> {
    return this.withWriteGate(() =>
      this.createFTSIndexUnsafe(rebuild, retries),
    );
  }

  private async createFTSIndexUnsafe(
    rebuild = false,
    retries = 5,
  ): Promise<void> {
    const table = await this.ensureTableUnsafe();
    if (rebuild) {
      try {
        await table.dropIndex("content_idx");
      } catch {}
    }
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await table.createIndex("content", {
          config: lancedb.Index.fts({ withPosition: true }),
        });
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("already exists")) {
          return;
        }
        // Retry on the same Lance commit-conflict pattern that optimize() handles —
        // FTS rebuild and compaction race when both try to write the manifest.
        if (
          attempt < retries &&
          (msg.includes("conflict") || msg.includes("Retryable"))
        ) {
          const delay = 1000 * 2 ** (attempt - 1);
          log(
            "vectordb",
            `createFTSIndex conflict (attempt ${attempt}/${retries}), retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        // If position error, try dropping and recreating once
        if (msg.includes("position")) {
          try {
            await table.dropIndex("content_idx");
            await table.createIndex("content", {
              config: lancedb.Index.fts({ withPosition: true }),
            });
            log("vectordb", "Rebuilt FTS index with position support");
            return;
          } catch {}
        }
        console.warn("Failed to create FTS index:", e);
        return;
      }
    }
  }

  async optimize(
    retries = 5,
    retentionMs = 0,
    bypassExclusiveMutation = false,
  ): Promise<void> {
    if (!bypassExclusiveMutation) {
      while (this.exclusiveMutationPromise) await this.exclusiveMutationPromise;
      if (this.closed) throw new Error("VectorDB connection is closed");
    }
    if (this.compactingPromise) {
      debug("vectordb", "Optimize already in progress, skipping");
      await this.compactingPromise;
      return;
    }

    let resolveCompacting!: () => void;
    this.compactingPromise = new Promise<void>((resolve) => {
      resolveCompacting = resolve;
    });
    this.activeCompactions++;
    try {
      const table = await this.ensureTableUnsafe();
      const cutoff = new Date(Date.now() - retentionMs);

      for (let attempt = 1; attempt <= retries; attempt++) {
        await this.drainWrites();

        try {
          const done = timer("vectordb", "optimize");
          const stats = await table.optimize({
            cleanupOlderThan: cutoff,
            deleteUnverified: true,
          });
          done();

          const { compaction, prune } = stats;
          if (
            compaction.fragmentsRemoved > 0 ||
            prune.oldVersionsRemoved > 0 ||
            prune.bytesRemoved > 0
          ) {
            log(
              "vectordb",
              `Compacted: ${compaction.fragmentsRemoved} frags → ${compaction.fragmentsAdded}, ` +
                `pruned ${prune.oldVersionsRemoved} versions, ` +
                `freed ${(prune.bytesRemoved / 1024 / 1024).toFixed(1)}MB`,
            );
          } else {
            debug("vectordb", "Optimize: nothing to compact or prune");
          }
          return;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("Nothing to do")) {
            debug("vectordb", "Optimize: nothing to do");
            return;
          }
          // ENOSPC: return immediately — retrying will only make things worse
          if (
            msg.includes("No space left on device") ||
            msg.includes("os error 28")
          ) {
            log(
              "vectordb",
              `Optimize failed (ENOSPC): disk full — skipping retries`,
            );
            return;
          }
          if (
            attempt < retries &&
            (msg.includes("conflict") || msg.includes("Retryable"))
          ) {
            const delay = 1000 * 2 ** (attempt - 1);
            log(
              "vectordb",
              `Optimize conflict (attempt ${attempt}/${retries}), retrying in ${delay}ms`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          log("vectordb", `Optimize failed: ${msg}`);
          return;
        }
      }
    } finally {
      this.compactingPromise = null;
      resolveCompacting();
      this.activeCompactions--;
      if (this.activeCompactions === 0) {
        for (const resolve of this.compactionDrainResolvers) resolve();
        this.compactionDrainResolvers.clear();
      }
    }
  }

  /**
   * Run FTS rebuild + optimize as a single serialized operation.
   * Safe to call from multiple project processors — only one runs at a time.
   * Checks disk bloat ratio and retries optimize when bloat persists.
   */
  async runMaintenance(): Promise<void> {
    if (this.maintenanceRunning) {
      debug("vectordb", "Maintenance already running, skipping");
      return;
    }
    this.maintenanceRunning = true;
    try {
      const pressure = this.checkDiskPressure();

      if (pressure === "critical") {
        const freeGb = (this.getAvailableBytes() / 1024 / 1024 / 1024).toFixed(
          1,
        );
        log(
          "vectordb",
          `Maintenance skipped: disk critically low (${freeGb}GB free)`,
        );
        return;
      }

      await this.createFTSIndex();

      if (pressure === "low") {
        log("vectordb", `Low disk — single-pass optimize (no bloat retry)`);
        await this.optimize(1, 0, true);
        return;
      }

      // Normal maintenance: full optimize + bloat check
      await this.optimize(5, 0, true);

      const table = await this.ensureTable();
      const stats = await table.stats();
      const diskSize = this.getDirectorySize(this.lancedbDir);
      const logicalSize = stats.totalBytes;
      const bloatRatio = logicalSize > 0 ? diskSize / logicalSize : 0;

      // Only retry if disk is still ok after optimize (don't spiral)
      if (bloatRatio > 2.0 && this.checkDiskPressure() === "ok") {
        log(
          "vectordb",
          `Bloat detected after optimize: ${(diskSize / 1024 / 1024).toFixed(0)}MB disk vs ${(logicalSize / 1024 / 1024).toFixed(0)}MB logical (${bloatRatio.toFixed(1)}x) — retrying`,
        );
        await new Promise((r) => setTimeout(r, 2000));
        await this.optimize(5, 0, true);
      }
    } finally {
      this.maintenanceRunning = false;
    }
  }

  async compactIfNeeded(
    threshold = FRAGMENT_COMPACT_THRESHOLD,
  ): Promise<boolean> {
    if (this.maintenanceRunning) return false;
    this.maintenanceRunning = true;
    try {
      if (this.checkDiskPressure() !== "ok") return false;
      const table = await this.ensureTable();
      const stats = await table.stats();
      if (stats.fragmentStats.numSmallFragments > threshold) {
        log(
          "vectordb",
          `Fragment threshold exceeded (${stats.fragmentStats.numSmallFragments} > ${threshold}) — compacting`,
        );
        await this.optimize(2, 0, true);
        return true;
      }
    } catch (err) {
      debug("vectordb", `compactIfNeeded check failed: ${err}`);
    } finally {
      this.maintenanceRunning = false;
    }
    return false;
  }

  private getDirectorySize(dirPath: string): number {
    let totalSize = 0;
    try {
      const items = fs.readdirSync(dirPath);
      for (const item of items) {
        const itemPath = `${dirPath}/${item}`;
        const s = fs.statSync(itemPath);
        if (s.isDirectory()) {
          totalSize += this.getDirectorySize(itemPath);
        } else {
          totalSize += s.size;
        }
      }
    } catch {}
    return totalSize;
  }

  async hasAnyRows(): Promise<boolean> {
    const table = await this.ensureTable();
    const rows = await table.query().select(["id"]).limit(1).toArray();
    return rows.length > 0;
  }

  async hasRowsForPath(pathPrefix: string): Promise<boolean> {
    const table = await this.ensureTable();
    const prefix = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
    const rows = await table
      .query()
      .select(["id"])
      .where(pathStartsWith(prefix))
      .limit(1)
      .toArray();
    return rows.length > 0;
  }

  async countRowsForPath(pathPrefix: string): Promise<number> {
    const table = await this.ensureTable();
    const prefix = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
    return table.countRows(pathStartsWith(prefix));
  }

  async countDistinctFilesForPath(pathPrefix: string): Promise<number> {
    return (await this.getDistinctPathsForPrefix(pathPrefix)).size;
  }

  async getDistinctPathsForPrefix(pathPrefix: string): Promise<Set<string>> {
    const table = await this.ensureTable();
    const prefix = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
    const rows = await table
      .query()
      .select(["path"])
      .where(pathStartsWith(prefix))
      .toArray();
    const unique = new Set<string>();
    for (const r of rows) {
      unique.add(String(r.path));
    }
    return unique;
  }

  async getStats(): Promise<{ chunks: number; totalBytes: number }> {
    const table = await this.ensureTable();
    const [count, stats] = await Promise.all([
      table.countRows(),
      table.stats(),
    ]);
    return { chunks: count, totalBytes: stats.totalBytes };
  }

  async getDistinctFileCount(): Promise<number> {
    const table = await this.ensureTable();
    const rows = await table.query().select(["path"]).toArray();
    return new Set(rows.map((r) => r.path)).size;
  }

  async deletePaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    this.ensureDiskOk();
    const unique = Array.from(new Set(paths));
    const batchSize = 500;
    await this.withWriteGate(async () => {
      const table = await this.ensureTableUnsafe();
      for (let i = 0; i < unique.length; i += batchSize) {
        const slice = unique.slice(i, i + batchSize);
        const values = slice.map((p) => `'${escapeSqlString(p)}'`).join(",");
        const where = `path IN (${values})`;
        // Skip no-op deletes to avoid creating empty LanceDB versions
        const existing = await table
          .query()
          .select(["id"])
          .where(where)
          .limit(1)
          .toArray();
        if (existing.length > 0) {
          await table.delete(where);
        }
      }
    });
  }

  async updateRows(
    ids: string[],
    field: string,
    values: (string | null)[],
  ): Promise<void> {
    if (!ids.length) return;
    await this.withWriteGate(async () => {
      const table = await this.ensureTableUnsafe();
      for (let i = 0; i < ids.length; i++) {
        const escaped = escapeSqlString(ids[i]);
        await table.update({
          where: `id = '${escaped}'`,
          values: { [field]: values[i] ?? "" },
        });
      }
    });
  }

  async deletePathsExcludingIds(
    paths: string[],
    excludeIds: string[],
  ): Promise<void> {
    if (!paths.length) return;
    this.ensureDiskOk();
    const unique = Array.from(new Set(paths));
    const batchSize = 500;
    const idExclusion =
      excludeIds.length > 0
        ? ` AND id NOT IN (${excludeIds.map((id) => `'${escapeSqlString(id)}'`).join(",")})`
        : "";
    await this.withWriteGate(async () => {
      const table = await this.ensureTableUnsafe();
      for (let i = 0; i < unique.length; i += batchSize) {
        const slice = unique.slice(i, i + batchSize);
        const values = slice.map((p) => `'${escapeSqlString(p)}'`).join(",");
        const where = `path IN (${values})${idExclusion}`;
        const existing = await table
          .query()
          .select(["id"])
          .where(where)
          .limit(1)
          .toArray();
        if (existing.length > 0) {
          await table.delete(where);
        }
      }
    });
  }

  async deletePathsWithPrefix(prefix: string): Promise<void> {
    this.ensureDiskOk();
    // Slash-terminate so a project root can't bleed into a sibling
    // (`/repo/app` must not delete `/repo/app2`), and use starts_with so `_`/`%`
    // in the path are literal, not LIKE wildcards. Destructive path — keep this
    // self-protective even if a caller forgets to normalize.
    const dirPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    await this.withWriteGate(async () => {
      const table = await this.ensureTableUnsafe();
      await table.delete(pathStartsWith(dirPrefix));
    });
  }

  async drop(): Promise<void> {
    await this.withExclusiveTableMutation(async (db) => {
      try {
        await db.dropTable(TABLE_NAME);
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    });
  }

  async close(
    options: { releaseLease?: boolean; requireClosed?: boolean } = {},
  ): Promise<void> {
    if (this.closePromise) {
      if (
        (options.requireClosed === true && !this.requireClosedOnClose) ||
        (options.releaseLease === false && this.releaseLeaseOnClose)
      ) {
        throw new Error(
          "VectorDB close already started with weaker ownership semantics",
        );
      }
      return this.closePromise;
    }
    this.releaseLeaseOnClose = options.releaseLease ?? true;
    this.requireClosedOnClose = options.requireClosed ?? false;
    this.closed = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    if (this.exclusiveMutationPromise) await this.exclusiveMutationPromise;
    await this.leaseTransitionTail;
    await Promise.all([this.drainWrites(), this.drainCompactions()]);
    this.leaseAbort.abort();
    // Drain in-flight maintenance before tearing down the connection — otherwise
    // optimize/createIndex will hit a null db and log "VectorDB connection is closed".
    if (this.maintenancePromise) {
      await Promise.race([
        this.maintenancePromise,
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
      this.maintenancePromise = null;
    }
    this.unregisterCleanup?.();
    this.unregisterCleanup = undefined;
    let closeError: unknown;
    if (this.db?.close) {
      try {
        const closing = this.db.close();
        if (this.requireClosedOnClose) await closing;
        else {
          await Promise.race([
            closing,
            new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
          ]);
        }
      } catch (error) {
        closeError = error;
      }
    }
    this.db = null;
    if (this.leasePromise) {
      let lease: StoreLease | null = null;
      try {
        lease = await this.leasePromise;
      } catch {
        this.leasePromise = null;
      }
      if (lease) {
        try {
          if (this.releaseLeaseOnClose) await lease.release();
          else lease.relinquish(this.leaseHolder);
          this.leasePromise = null;
        } catch (error) {
          closeError = closeError
            ? new Error(
                `VectorDB close and store lease release failed: ${String(closeError)}; ${String(error)}`,
              )
            : error;
        }
      }
    }
    if (closeError) throw closeError;
  }
}
