import * as fs from "node:fs";
import * as path from "node:path";
import { hasStoreExclusiveIntent, StoreLeaseTimeoutError } from "./store-lease";

/**
 * A power loss on a filesystem with delayed allocation can bring back the
 * files of the last few Lance commits as 0 bytes. The newest manifest then
 * fails to load and every read of the table fails. Lance keeps every older
 * version, so the table is rolled back by moving the damaged tail files out
 * of the table into a dated quarantine folder. Nothing is ever deleted.
 */

const MAGIC_MANIFEST = Buffer.from("LANC");
const MAGIC_ARROW = Buffer.from("ARROW1");
const U64_MAX = BigInt("18446744073709551615");
const I64_MAX = BigInt("9223372036854775807");

export type TornFile = { path: string; size: number; reason: string };

export type TornStoreAssessment = {
  tableDir: string;
  status: "healthy" | "repairable" | "refused";
  latestVersion: number | null;
  restoreVersion: number | null;
  /** Damaged files newer than the restore version: the rollback moves these. */
  moves: TornFile[];
  /** Damage the rollback may not touch: any entry blocks automatic repair. */
  refusals: TornFile[];
  summary: string;
};

export type TornStoreRepair = TornStoreAssessment & {
  quarantineDir: string | null;
  moved: TornFile[];
};

/** The Lance errors a torn tail commit produces on open or read. */
export function isTornStoreError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Invalid range \d+\.\.\d+ for object of size 0 bytes/.test(msg) ||
    /file size is smaller than 16 bytes/.test(msg) ||
    /magic number does not match/.test(msg) ||
    /manifest length does not match/.test(msg)
  );
}

/** Why a repair did not run, naming the processes that hold the store. */
export function describeRepairFailure(error: unknown): string {
  if (error instanceof StoreLeaseTimeoutError)
    return `the store is held by ${error.blockers.map((o) => `${o.role} pid=${o.pid}`).join(", ") || "an unverified owner"}`;
  return error instanceof Error ? error.message : String(error);
}

/** Version from a manifest file name: V2 names hold u64::MAX - version. */
export function manifestVersion(name: string): number | null {
  const match = /^(\d+)\.manifest$/.exec(name);
  if (!match) return null;
  const n = BigInt(match[1]);
  const version = n > I64_MAX ? U64_MAX - n : n;
  return version <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(version) : null;
}

type ManifestRefs = {
  version: number;
  dataFiles: Array<{ path: string; size: number }>;
  deletionFiles: string[];
};

class Reader {
  pos = 0;
  constructor(
    private readonly buf: Buffer,
    private readonly end = buf.length,
  ) {}
  done() {
    return this.pos >= this.end;
  }
  /** A u64 exactly: deletion file ids are random 64-bit numbers. */
  big(): bigint {
    let result = BigInt(0);
    for (let shift = 0; shift < 70; shift += 7) {
      if (this.pos >= this.end) throw new Error("truncated varint");
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << BigInt(shift);
      if ((byte & 0x80) === 0) return result;
    }
    throw new Error("varint too long");
  }
  varint(): number {
    const result = this.big();
    if (result > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("varint out of range");
    return Number(result);
  }
  sub(): Reader {
    const len = this.varint();
    if (this.pos + len > this.end) throw new Error("truncated field");
    const reader = new Reader(this.buf, this.pos + len);
    reader.pos = this.pos;
    this.pos += len;
    return reader;
  }
  string(): string {
    const reader = this.sub();
    return this.buf.toString("utf8", reader.pos, reader.end);
  }
  skip(wire: number) {
    if (wire === 0) this.big();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.sub();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
    if (this.pos > this.end) throw new Error("truncated field");
  }
  /** Calls fn(field, wire) for each field; fn returns false to skip it. */
  fields(fn: (field: number, wire: number) => boolean) {
    while (!this.done()) {
      const key = this.varint();
      const field = key >>> 3;
      const wire = key & 7;
      if (!fn(field, wire)) this.skip(wire);
    }
  }
}

function parseFragment(reader: Reader, refs: ManifestRefs) {
  let id = 0;
  const files: Array<{ path: string; size: number }> = [];
  let deletion: { type: number; readVersion: number; id: bigint } | null = null;
  reader.fields((field, wire) => {
    if (field === 1 && wire === 0) id = reader.varint();
    else if (field === 2 && wire === 2) {
      const file = reader.sub();
      let filePath = "";
      let size = 0;
      let external = false;
      file.fields((f, w) => {
        if (f === 1 && w === 2) filePath = file.string();
        else if (f === 6 && w === 0) size = file.varint();
        else if (f === 7) external = true;
        else return false;
        return true;
      });
      // A file on another base path is outside this table directory.
      if (filePath && !external) files.push({ path: filePath, size });
    } else if (field === 3 && wire === 2) {
      const del = reader.sub();
      deletion = { type: 0, readVersion: 0, id: BigInt(0) };
      const current = deletion;
      del.fields((f, w) => {
        if (w !== 0) return false;
        if (f === 1) current.type = del.varint();
        else if (f === 2) current.readVersion = del.varint();
        else if (f === 3) current.id = del.big();
        else return false;
        return true;
      });
    } else return false;
    return true;
  });
  refs.dataFiles.push(...files);
  const del = deletion as {
    type: number;
    readVersion: number;
    id: bigint;
  } | null;
  if (del)
    refs.deletionFiles.push(
      `${id}-${del.readVersion}-${del.id}.${del.type === 1 ? "bin" : "arrow"}`,
    );
}

/**
 * The checks Lance's read_manifest makes, then the fragment list. Throws a
 * plain reason when the file would not load.
 */
export function parseManifest(buf: Buffer): ManifestRefs {
  if (buf.length === 0) throw new Error("empty");
  if (buf.length < 16) throw new Error("smaller than 16 bytes");
  if (!buf.subarray(buf.length - 4).equals(MAGIC_MANIFEST))
    throw new Error("no manifest footer");
  const pos = Number(buf.readBigInt64LE(buf.length - 16));
  if (pos < 0 || pos + 4 > buf.length - 16)
    throw new Error("manifest position out of range");
  const length = buf.readUInt32LE(pos);
  if (length !== buf.length - pos - 20)
    throw new Error("manifest length does not match");
  const refs: ManifestRefs = { version: -1, dataFiles: [], deletionFiles: [] };
  const reader = new Reader(buf, pos + 4 + length);
  reader.pos = pos + 4;
  reader.fields((field, wire) => {
    if (field === 2 && wire === 2) parseFragment(reader.sub(), refs);
    else if (field === 3 && wire === 0) refs.version = reader.varint();
    else return false;
    return true;
  });
  return refs;
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function hasTail(file: string, size: number, magic: Buffer): boolean {
  if (size < magic.length) return false;
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(magic.length);
    fs.readSync(fd, buf, 0, magic.length, size - magic.length);
    return buf.equals(magic);
  } finally {
    fs.closeSync(fd);
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function damageOf(file: string, stat: fs.Stats, magic?: Buffer): string | null {
  if (stat.size === 0) return "empty";
  if (magic && !hasTail(file, stat.size, magic)) return "no file footer";
  return null;
}

/**
 * Read-only: finds the newest whole version (its manifest loads and every data
 * and deletion file it names exists at full size) and the damaged files newer
 * than it. Takes no lease, so it is safe while the daemon runs.
 */
export function assessTornStore(tableDir: string): TornStoreAssessment {
  const versionsDir = path.join(tableDir, "_versions");
  const manifests = listDir(versionsDir)
    .map((name) => ({ name, version: manifestVersion(name) }))
    .filter((m): m is { name: string; version: number } => m.version !== null)
    .sort((a, b) => b.version - a.version);
  const base = {
    tableDir,
    latestVersion: manifests[0]?.version ?? null,
    restoreVersion: null as number | null,
    moves: [] as TornFile[],
    refusals: [] as TornFile[],
  };
  if (manifests.length === 0)
    return { ...base, status: "healthy", summary: "no table versions" };

  let restore: { version: number; mtimeMs: number; refs: ManifestRefs } | null =
    null;
  const newer: TornFile[] = [];
  const newerWhole: TornFile[] = [];
  for (const m of manifests) {
    const rel = `_versions/${m.name}`;
    const file = path.join(tableDir, rel);
    const stat = statOrNull(file);
    // Version cleanup can remove an old manifest while a read-only check runs.
    if (!stat) continue;
    let refs: ManifestRefs;
    try {
      refs = parseManifest(fs.readFileSync(file));
      if (refs.version !== m.version)
        throw new Error(`records version ${refs.version}`);
    } catch (err) {
      newer.push({
        path: rel,
        size: stat.size,
        reason: (err as Error).message,
      });
      continue;
    }
    const broken: string[] = [];
    for (const data of refs.dataFiles) {
      const s = statOrNull(path.join(tableDir, "data", data.path));
      if (!s) broken.push(`data/${data.path} missing`);
      else if (s.size === 0) broken.push(`data/${data.path} empty`);
      else if (data.size > 0 && s.size !== data.size)
        broken.push(`data/${data.path} is ${s.size} of ${data.size} bytes`);
    }
    for (const del of refs.deletionFiles) {
      const s = statOrNull(path.join(tableDir, "_deletions", del));
      if (!s) broken.push(`_deletions/${del} missing`);
      else if (s.size === 0) broken.push(`_deletions/${del} empty`);
    }
    if (broken.length === 0) {
      restore = { version: m.version, mtimeMs: stat.mtimeMs, refs };
      break;
    }
    newerWhole.push({
      path: rel,
      size: stat.size,
      reason: `manifest loads but names damaged files: ${broken.slice(0, 3).join(", ")}${broken.length > 3 ? ` and ${broken.length - 3} more` : ""}`,
    });
  }

  if (!restore)
    return {
      ...base,
      status: "refused",
      refusals: [...newerWhole, ...newer],
      summary: "no whole table version found; nothing moved",
    };
  base.restoreVersion = restore.version;
  if (restore.version === base.latestVersion)
    return {
      ...base,
      status: "healthy",
      summary: `latest version ${restore.version} is whole`,
    };

  // The rollback moves only empty or unreadable files. A loadable manifest
  // above the restore point is not damaged itself, so it blocks the repair.
  base.moves.push(...newer);
  base.refusals.push(...newerWhole);

  const referenced = {
    data: new Set(restore.refs.dataFiles.map((d) => d.path)),
    deletions: new Set(restore.refs.deletionFiles),
  };
  const classify = (rel: string, isNewer: boolean, magic?: Buffer) => {
    const file = path.join(tableDir, rel);
    const stat = statOrNull(file);
    if (!stat?.isFile()) return;
    const reason = damageOf(file, stat, magic);
    if (!reason) return;
    const entry = { path: rel, size: stat.size, reason };
    if (isNewer) base.moves.push(entry);
    else
      base.refusals.push({
        ...entry,
        reason: `${reason}, older than version ${restore.version}`,
      });
  };
  // Transaction and deletion names carry the read version, so a file built
  // on the restore version belongs to the first lost commit.
  for (const name of listDir(path.join(tableDir, "_transactions"))) {
    const match = /^(\d+)-.+\.txn$/.exec(name);
    if (match)
      classify(`_transactions/${name}`, Number(match[1]) >= restore.version);
  }
  for (const name of listDir(path.join(tableDir, "_deletions"))) {
    const match = /^\d+-(\d+)-\d+\.(arrow|bin)$/.exec(name);
    if (!match || referenced.deletions.has(name)) continue;
    classify(
      `_deletions/${name}`,
      Number(match[1]) >= restore.version,
      match[2] === "arrow" ? MAGIC_ARROW : undefined,
    );
  }
  // Data files carry no version: newer means written after the restore manifest.
  for (const name of listDir(path.join(tableDir, "data"))) {
    if (!name.endsWith(".lance") || referenced.data.has(name)) continue;
    const stat = statOrNull(path.join(tableDir, "data", name));
    if (!stat) continue;
    classify(`data/${name}`, stat.mtimeMs > restore.mtimeMs, MAGIC_MANIFEST);
  }

  const latest = base.latestVersion;
  if (base.refusals.length > 0)
    return {
      ...base,
      status: "refused",
      summary: `version ${latest} is damaged but ${base.refusals.length} damaged file(s) are not safe to move automatically; nothing moved`,
    };
  return {
    ...base,
    status: "repairable",
    summary: `version ${latest} is damaged; version ${restore.version} is the newest whole version (${base.moves.length} damaged file(s) to move)`,
  };
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function fsyncDir(dir: string) {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* Directory fsync is unavailable on some platforms. */
  }
}

/**
 * Rolls a torn table back to its newest whole version. The caller must hold
 * the store's exclusive lease; the assessment is redone under it. Damaged
 * files move to <store parent>/quarantine-torn-store-<stamp>/ with a moved.txt
 * listing each one. Returns the assessment when there is nothing to do or the
 * damage is not safe to move.
 */
export function repairTornStore(
  storeDir: string,
  tableName = "chunks",
  now = new Date(),
): TornStoreRepair {
  if (!hasStoreExclusiveIntent(storeDir))
    throw new Error("torn store repair requires the exclusive store lease");
  const tableDir = path.join(storeDir, `${tableName}.lance`);
  const found = assessTornStore(tableDir);
  if (found.status !== "repairable")
    return { ...found, quarantineDir: null, moved: [] };
  for (const file of found.moves)
    if (file.path.includes(".pre-") || file.path.includes(".."))
      throw new Error(`refusing to move ${file.path}`);

  const name = path.join(
    path.dirname(storeDir),
    `quarantine-torn-store-${stamp(now)}`,
  );
  let quarantineDir = name;
  for (let n = 2; fs.existsSync(quarantineDir); n++)
    quarantineDir = `${name}-${n}`;
  const target = path.join(quarantineDir, path.basename(tableDir));
  fs.mkdirSync(target, { recursive: true });
  const list = [
    `# ${found.summary}`,
    `# table ${tableDir}`,
    `# restored version ${found.restoreVersion}`,
    ...found.moves.map((f) => `${f.path}\t${f.size}\t${f.reason}`),
    "",
  ].join("\n");
  const listFile = path.join(quarantineDir, "moved.txt");
  fs.writeFileSync(listFile, list);
  const fd = fs.openSync(listFile, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  const moved: TornFile[] = [];
  const dirs = new Set<string>();
  for (const file of found.moves) {
    const to = path.join(target, file.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(path.join(tableDir, file.path), to);
    moved.push(file);
    dirs.add(path.dirname(path.join(tableDir, file.path)));
    dirs.add(path.dirname(to));
  }
  for (const dir of dirs) fsyncDir(dir);

  const after = assessTornStore(tableDir);
  const restored =
    after.status === "healthy" && after.latestVersion === found.restoreVersion;
  return {
    ...found,
    quarantineDir,
    moved,
    summary: restored
      ? `Rolled the store back from damaged version ${found.latestVersion} to whole version ${found.restoreVersion}: moved ${moved.length} empty or unreadable file(s) to ${quarantineDir}`
      : `Moved ${moved.length} damaged file(s) to ${quarantineDir}, but the store is still not whole: ${after.summary}`,
  };
}

export type MetaReconcileEntry = {
  path: string;
  reason: "no rows" | "rows from an older revision";
};

/**
 * After a rollback, a file whose metadata records vectors at a hash the table
 * no longer holds would stay out of search until it changes again. The rows'
 * hash column is the file's content hash, so it is the exact signal. Marking a
 * file removes its metadata entry: the next catch-up reprocesses any file with
 * no entry and rewrites its rows.
 */
export async function reconcileMetaWithTable(
  table: { getPathHashes(): Promise<Map<string, Set<string>>> },
  meta: {
    entries(): AsyncIterable<{
      path: string;
      entry: { hash: string; hasVectors?: boolean };
    }>;
    delete(path: string): void;
    flushed?(): Promise<void>;
  },
  options: { dryRun: boolean },
): Promise<MetaReconcileEntry[]> {
  const hashes = await table.getPathHashes();
  const marked: MetaReconcileEntry[] = [];
  for await (const { path: file, entry } of meta.entries()) {
    if (entry.hasVectors !== true) continue;
    const present = hashes.get(file);
    if (present?.has(entry.hash)) continue;
    marked.push({
      path: file,
      reason: present ? "rows from an older revision" : "no rows",
    });
  }
  if (!options.dryRun) {
    for (const { path: file } of marked) meta.delete(file);
    await meta.flushed?.();
  }
  return marked;
}
