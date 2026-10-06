import * as fs from "node:fs";
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
  STALE_TEMP_FILE_AGE_MS,
} from "../../config";
import {
  embeddingReuseKey,
  type ReusableEmbedding,
  toBytes,
  toFloat32,
  toInt32,
} from "../index/embedding-reuse";
import { readGlobalConfig } from "../index/index-config";
import { registerCleanup } from "../utils/cleanup";
import { escapeSqlString, pathStartsWith } from "../utils/filter-builder";
import { debug, log, timer } from "../utils/logger";
import {
  QUERY_EXECUTION_OPTIONS,
  streamQueryRows,
} from "../utils/query-timeout";
import { annMinRows, isAnnEnabled } from "./ann-config";
import { type CompactionResult, skippedCompaction } from "./compaction-result";
import * as lancedb from "./lance-sdk";
import {
  assertFreshDiskMutationAllowed,
  assertStoreMutationAllowed,
  availableStoreDiskBytes,
  DiskPressureError,
  FULL_TABLE_MAINTENANCE_DISABLED_REASON,
  fullTableMaintenanceDisabled,
  recordMaintenanceContainment,
  storeMutationDeniedReason,
} from "./maintenance-policy";
import { StoreLease } from "./store-lease";
import type { VectorRecord } from "./types";

export type DiskPressureLevel = "ok" | "low" | "critical";

export interface StaleTempFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Find abandoned Lance scratch files under `<lancedbDir>/ *.lance/data`.
 *
 * Lance stages a new fragment in a dot-prefixed `.tmp*` file and renames it into
 * place on success. A killed or panicking optimize leaves the temp behind, and
 * nothing ever collects it: it appears in no manifest, so `deleteUnverified`
 * cannot prove it is garbage, and the leading dot hides it from `ls`. The result
 * is permanent disk bloat that no amount of optimizing reclaims.
 *
 * Only files older than `minAgeMs` are reported. An in-flight write keeps
 * bumping its temp file's mtime, so the age gate — not a writer count — is what
 * makes deleting the result safe from any process.
 */
export function findStaleLanceTempFiles(
  lancedbDir: string,
  minAgeMs: number = STALE_TEMP_FILE_AGE_MS,
): StaleTempFile[] {
  const found: StaleTempFile[] = [];
  const cutoff = Date.now() - minAgeMs;
  let tables: string[];
  try {
    tables = fs.readdirSync(lancedbDir);
  } catch {
    return found;
  }
  for (const tableDir of tables) {
    if (!tableDir.endsWith(".lance")) continue;
    const dataDir = `${lancedbDir}/${tableDir}/data`;
    let entries: string[];
    try {
      entries = fs.readdirSync(dataDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(".tmp")) continue;
      const full = `${dataDir}/${entry}`;
      try {
        const s = fs.statSync(full);
        if (!s.isFile() || s.mtimeMs > cutoff) continue;
        found.push({ path: full, size: s.size, mtimeMs: s.mtimeMs });
      } catch {}
    }
  }
  return found;
}

/**
 * Delete abandoned Lance scratch files. Returns bytes actually reclaimed —
 * a file that vanishes between the scan and the unlink is not counted, so the
 * number reported is never larger than what was freed.
 */
export function sweepStaleLanceTempFiles(
  lancedbDir: string,
  minAgeMs: number = STALE_TEMP_FILE_AGE_MS,
): { filesRemoved: number; bytesFreed: number } {
  let filesRemoved = 0;
  let bytesFreed = 0;
  for (const f of findStaleLanceTempFiles(lancedbDir, minAgeMs)) {
    try {
      fs.unlinkSync(f.path);
      filesRemoved++;
      bytesFreed += f.size;
    } catch {}
  }
  return { filesRemoved, bytesFreed };
}

export { DiskPressureError } from "./maintenance-policy";

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
const CLEAN_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Floor between opportunistic full-table compactions.
 *
 * A compaction rewrites the whole table, so its cost scales with store size, not
 * with how much changed. Neither opportunistic caller was rate-limited: the
 * 5-minute maintenance tick re-optimizes whenever the write epoch moved, and
 * `compactIfNeeded` fires whenever small fragments cross a threshold. On a store
 * under continuous reindex pressure both are true essentially always, so the
 * table gets rewritten every few minutes forever.
 *
 * That is not hypothetical. On 2026-08-16..17 this store (16 GB) took 43 full
 * compactions in two days — an accelerating 6 → 30 → 63 → 54 per day — which a
 * microstackshot measured as 549.76 GB of file-backed writes in 12.3 hours. On
 * macOS 26.5.2 that write volume exhausted the `data.kalloc.1024` kernel zone and
 * panicked the host. See docs/2026-08-04-macos-kernel-zone-panic-incident.md.
 *
 * The floor caps compaction at twice an hour regardless of how much churn arrives.
 * Fragments accumulating between passes cost read performance, which is recoverable;
 * unbounded rewrite volume was not.
 */
const COMPACTION_MIN_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Ceiling for the unproductive-compaction backoff.
 *
 * A compaction that removes no fragments and frees no bytes rewrote the table for
 * nothing, and the next one a few minutes later will almost certainly do the same.
 * The interval doubles on each such pass and resets the moment one does real work,
 * so a store that cannot be improved stops paying for the attempt.
 */
const COMPACTION_MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Failed rewrites leave complete fragment copies until a later successful prune.
// One fresh-snapshot retry is enough; five attempts stranded ~70 GB in Oct 2026.
const COMPACTION_MAX_ATTEMPTS = 2;

/**
 * Bounds for LanceDB's per-connection caches.
 *
 * `lancedb.connect()` without a Session gets a 6 GB index cache and a 1 GB
 * metadata cache, and a connection lives as long as the daemon. On a 48 GB host
 * that was already swapping, the daemon reached a 4 GB footprint (9.6 GB peak),
 * almost all native malloc and invisible to the RSS-based recycle because most of
 * it had been compressed or swapped. The whole on-disk index directory for a
 * 430k-row store is ~650 MB, so 1 GB still holds every index; the metadata cache
 * only needs the latest manifests, not every retained version.
 */
const LANCE_INDEX_CACHE_MB = envMb("GMAX_LANCE_INDEX_CACHE_MB", 1024);
const LANCE_METADATA_CACHE_MB = envMb("GMAX_LANCE_METADATA_CACHE_MB", 256);

function envMb(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function createLanceSession(): lancedb.Session {
  const mb = (n: number) => BigInt(n * 1024 * 1024);
  return new lancedb.Session(
    mb(LANCE_INDEX_CACHE_MB),
    mb(LANCE_METADATA_CACHE_MB),
  );
}

export class VectorDB {
  private db: lancedb.Connection | null = null;
  private session: lancedb.Session | null = null;
  private unregisterCleanup?: () => void;
  private closed = false;
  private readonly vectorDim: number;
  private maintenanceRunning = false;
  private maintenancePromise: Promise<void> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private writeEpoch = 0;
  private maintainedEpoch = -1;
  private maintainedTableVersion: number | null = null;
  private lastMaintenanceMs = 0;
  private ftsIndexEnsured = false;
  /** Only an index owner may create/rebuild shared indexes — see markIndexOwner. */
  private indexOwner = false;
  private lastOptimizeDidWork = false;
  private lastCompactionResult: CompactionResult | null = null;
  /** Compaction rate limiter — see COMPACTION_MIN_INTERVAL_MS. */
  private lastCompactionMs = 0;
  private compactionIntervalMs = COMPACTION_MIN_INTERVAL_MS;
  private maintenanceRunner: (fn: () => Promise<void>) => Promise<void> = (
    fn,
  ) => fn();
  /** Latched when a from-scratch FTS rebuild failed to stop an optimize
   *  panic. Stops the (expensive) rebuild from re-running every maintenance
   *  tick for a panic it cannot fix; cleared when an optimize succeeds. */
  private ftsPanicRecoveryExhausted = false;
  private annPanicRecoveryExhausted = false;
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
    if (fullTableMaintenanceDisabled()) {
      this.recordSkippedCompaction(
        recordMaintenanceContainment(this.lancedbDir),
      );
      return;
    }
    if (runOperation) this.maintenanceRunner = runOperation;
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      if (this.closed) return;
      // Skip if a previous tick is still running so close() has a single
      // promise to await instead of a chain.
      if (this.maintenancePromise) return;
      if (!this.maintenanceDue()) return;
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
      // Compare against the promise actually stored, not `run`: `.finally()`
      // returns a new promise, so checking `run` never matched and the field
      // latched non-null forever — isMaintenanceActive() then read true for the
      // daemon's whole life, silently blocking every recycle and idle shutdown.
      const tracked: Promise<void> = run.finally(() => {
        if (this.maintenancePromise === tracked) this.maintenancePromise = null;
      });
      this.maintenancePromise = tracked;
    }, MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref();
  }

  /** True iff a maintenance tick is currently running. Used by the daemon to
   *  defer idle shutdown so we don't tear down LanceDB mid-optimize. */
  /** Bytes held by LanceDB's index + metadata caches (0 before first connect). */
  cacheSizeBytes(): number {
    try {
      return Number(this.session?.sizeBytes() ?? 0);
    } catch {
      return 0;
    }
  }

  isMaintenanceActive(): boolean {
    return this.maintenancePromise !== null;
  }

  private maintenanceDue(): boolean {
    return (
      this.writeEpoch !== this.maintainedEpoch ||
      !this.ftsIndexEnsured ||
      Date.now() - this.lastMaintenanceMs >= CLEAN_MAINTENANCE_INTERVAL_MS
    );
  }

  private markWriteCommitted(): void {
    this.writeEpoch++;
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
    const creatingStore = !fs.existsSync(this.lancedbDir);
    if (creatingStore) {
      assertStoreMutationAllowed();
      assertFreshDiskMutationAllowed(this.lancedbDir);
    }
    await this.getLease();
    if (this.closed) {
      throw new Error("VectorDB connection is closed");
    }
    if (!this.db) {
      if (creatingStore || !fs.existsSync(this.lancedbDir)) {
        assertStoreMutationAllowed();
        assertFreshDiskMutationAllowed(this.lancedbDir);
      }
      fs.mkdirSync(this.lancedbDir, { recursive: true });
      this.session = createLanceSession();
      // 0.38 accepts the legacy third argument in its types but drops it in
      // the JS wrapper. Put the session in native ConnectionOptions instead.
      this.db = await lancedb.connect(this.lancedbDir, {
        session: this.session,
      });
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
    return availableStoreDiskBytes(this.lancedbDir);
  }

  checkDiskPressure(fresh = false): DiskPressureLevel {
    const now = Date.now();
    if (
      !fresh &&
      now - this.lastDiskCheckMs < VectorDB.DISK_CHECK_INTERVAL_MS
    ) {
      return this.diskPressure;
    }
    this.lastDiskCheckMs = now;

    const avail = this.getAvailableBytes();
    let level: DiskPressureLevel;
    if (!Number.isFinite(avail) || avail < 0 || avail < DISK_CRITICAL_BYTES) {
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
          `CRITICAL: ${Number.isFinite(avail) ? `disk space critically low (${freeStr} free)` : "disk space unknown"} — writes suspended`,
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
    if (this.checkDiskPressure(true) === "critical") {
      throw new DiskPressureError();
    }
  }

  /**
   * Wrap a write operation so it coordinates with compaction.
   * Multiple writes can proceed concurrently (shared access),
   * but all writes pause when compaction wants exclusive access.
   */
  private async withWriteGate<T>(fn: () => Promise<T>): Promise<T> {
    assertStoreMutationAllowed();
    this.ensureDiskOk();
    while (this.exclusiveMutationPromise || this.compactingPromise) {
      if (this.closed) throw new Error("VectorDB connection is closed");
      await Promise.all(
        [this.exclusiveMutationPromise, this.compactingPromise].filter(
          (promise): promise is Promise<void> => promise !== null,
        ),
      );
    }
    if (this.closed) throw new Error("VectorDB connection is closed");
    assertStoreMutationAllowed();
    this.ensureDiskOk();
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
  /**
   * Cancel every in-flight wait on the store lease (exclusive-mutation
   * acquisition, initial lease attach). Called by the daemon at the start of
   * shutdown, *before* it drains active operations: a `remove`/`repair` that is
   * polling for the exclusive lease would otherwise hold its operation slot
   * until the lease deadline, and shutdown would wait on it — the lease abort
   * in `close()` never fires because `close()` runs after the drain. Idempotent.
   */
  abortLeaseWaits(): void {
    this.leaseAbort.abort();
  }

  async withExclusiveTableMutation<T>(
    mutation: (db: lancedb.Connection) => Promise<T>,
  ): Promise<T> {
    assertStoreMutationAllowed();
    this.ensureDiskOk();
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
          assertStoreMutationAllowed();
          this.ensureDiskOk();
          const db = await this.getDb();
          const result = await mutation(db);
          this.markWriteCommitted();
          return result;
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
        this.markWriteCommitted();
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
    if (
      storeMutationDeniedReason() !== null ||
      this.checkDiskPressure(true) === "critical"
    ) {
      const existing = await this.openExistingTableUnsafe();
      if (!existing)
        throw new Error("gmax store is quarantined and has no existing table");
      await this.validateSchema(existing);
      return existing;
    }
    return this.withWriteGate(() => this.ensureTableUnsafe());
  }

  private async ensureTableUnsafe(): Promise<lancedb.Table> {
    const db = await this.getDb();
    let table: lancedb.Table;
    try {
      table = await db.openTable(TABLE_NAME);
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      assertStoreMutationAllowed();
      log("db", `Creating table (${this.vectorDim}d)`);
      const schema = this.buildSchema();
      table = await db.createTable(TABLE_NAME, [this.seedRow()], {
        schema,
      });
      await table.delete("id = 'seed'");
      this.markWriteCommitted();
      return table;
    }

    await this.validateSchema(table);
    assertStoreMutationAllowed();
    await this.evolveSchema(table);
    return table;
  }

  private async openExistingTableUnsafe(): Promise<lancedb.Table | null> {
    const db = await this.getDb();
    try {
      return await db.openTable(TABLE_NAME);
    } catch (err) {
      if (isMissingTableError(err)) return null;
      throw err;
    }
  }

  private async readTableVersion(
    table: lancedb.Table | null,
  ): Promise<number | null> {
    if (!table || typeof table.version !== "function") return null;
    try {
      return await table.version();
    } catch {
      return null;
    }
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
      if (Array.isArray(val)) return Buffer.from(val);
      return Buffer.alloc(0);
    };

    const toNumberArray = (val: unknown): number[] => {
      if (Array.isArray(val)) return val.map((x) => Number(x) || 0);
      if (ArrayBuffer.isView(val) && (val as ArrayBufferView).buffer) {
        return Array.from(val as unknown as ArrayLike<number>);
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
        this.markWriteCommitted();
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
    if (fullTableMaintenanceDisabled()) {
      if (rebuild) throw new Error(FULL_TABLE_MAINTENANCE_DISABLED_REASON);
      // Existing indexes remain searchable; absence does not authorize a build.
      return this.adoptFTSIndex();
    }
    return this.withWriteGate(() =>
      this.createFTSIndexUnsafe(rebuild, retries),
    );
  }

  /**
   * Mark this instance as the store's index owner — the daemon, or a
   * deliberately exclusive CLI operation. Only an owner may create or rebuild
   * the shared FTS index; see `adoptFTSIndex`.
   */
  markIndexOwner(): void {
    this.indexOwner = true;
  }

  /** Whether this instance may create or rebuild shared indexes. */
  canBuildIndexes(): boolean {
    return this.indexOwner;
  }

  /**
   * Adopt the FTS index if one already exists, without ever building it.
   *
   * Search runs in *every* process — the daemon, each CLI invocation that falls
   * back in-process, each MCP session. `createFTSIndex` on a miss meant N
   * processes could issue `CreateIndex` against the same table version
   * concurrently: Lance rejects the losers with a retryable commit conflict
   * (observed 2026-08-17T00:03, all 5 retries lost) and every winner writes a
   * full-size inverted index — ~1.4GB each on this store, which is how
   * `_indices` reached 47GB across 35 near-identical copies.
   *
   * Building is therefore reserved for the explicit paths that already run
   * under an owner: daemon pre-warm, `gmax index`, and post-optimize
   * maintenance. Throws when no index exists so callers set `ftsAvailable =
   * false` and degrade to vector-only search — never silently reports FTS as
   * ready.
   */
  async adoptFTSIndex(): Promise<void> {
    if (this.ftsIndexEnsured) return;
    const table = await this.openExistingTableUnsafe();
    if (!table)
      throw new Error(
        "[vector-db] No existing table or FTS index; index maintenance is disabled",
      );
    const indices = await table.listIndices();
    const existing = indices.find(
      (index) =>
        index.name === "content_idx" || index.columns.includes("content"),
    );
    if (!existing) {
      throw new Error(
        "[vector-db] FTS index not built yet; this process is not the index owner",
      );
    }
    this.ftsIndexEnsured = true;
  }

  async createVectorIndex(
    rebuild = false,
    retries = 5,
    checkOnly = false,
  ): Promise<boolean> {
    if (fullTableMaintenanceDisabled()) {
      debug(
        "vectordb",
        "ANN/index maintenance disabled by host-safety containment",
      );
      return false;
    }
    if (this.checkDiskPressure() !== "ok") {
      debug("vectordb", "ANN index skipped under disk pressure");
      return false;
    }
    return this.withWriteGate(() =>
      this.createVectorIndexUnsafe(rebuild, retries, checkOnly),
    );
  }

  private async createVectorIndexUnsafe(
    rebuild: boolean,
    retries: number,
    checkOnly: boolean,
  ): Promise<boolean> {
    const table = await this.ensureTableUnsafe();
    const rowCount = await table.countRows();
    if (rowCount < annMinRows()) return false;

    const indices = await table.listIndices();
    const vectorIndex = indices.find(
      (index) =>
        index.name === "vector_idx" || index.columns.includes("vector"),
    );
    const pathIndex = indices.find(
      (index) => index.name === "path_idx" || index.columns.includes("path"),
    );
    const vectorStats = vectorIndex
      ? await table.indexStats(vectorIndex.name)
      : undefined;
    const staleRatio = vectorStats
      ? vectorStats.numUnindexedRows / Math.max(1, vectorStats.numIndexedRows)
      : 0;
    let needsVector =
      isAnnEnabled() &&
      (rebuild ||
        !vectorIndex ||
        vectorStats?.distanceType?.toLowerCase() !== "l2" ||
        staleRatio > 0.2);
    let needsPath = rebuild || !pathIndex;
    if (!needsVector && !needsPath) return false;
    if (checkOnly) {
      debug(
        "vectordb",
        `ANN maintenance due (vector=${needsVector}, path=${needsPath}, unindexed=${vectorStats?.numUnindexedRows ?? 0})`,
      );
      return true;
    }

    let rebuiltAfterPanic = false;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (needsVector) {
          const numPartitions = Math.max(
            64,
            Math.min(2048, Math.round(Math.sqrt(rowCount))),
          );
          await table.createIndex("vector", {
            config: lancedb.Index.ivfFlat({
              distanceType: "l2",
              numPartitions,
            }),
            name: "vector_idx",
            replace: true,
          });
        }
        if (needsPath) {
          await table.createIndex("path", {
            config: lancedb.Index.btree(),
            name: "path_idx",
            replace: true,
          });
        }
        this.annPanicRecoveryExhausted = false;
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          attempt < retries &&
          (message.includes("conflict") || message.includes("Retryable"))
        ) {
          const delay = 1000 * 2 ** (attempt - 1);
          log(
            "vectordb",
            `createVectorIndex conflict (attempt ${attempt}/${retries}), retrying in ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        if (
          message.includes("Panic") &&
          attempt < retries &&
          !rebuiltAfterPanic &&
          !this.annPanicRecoveryExhausted
        ) {
          rebuiltAfterPanic = true;
          for (const name of ["vector_idx", "path_idx"]) {
            try {
              await table.dropIndex(name);
            } catch {}
          }
          needsVector = isAnnEnabled();
          needsPath = true;
          continue;
        }
        if (rebuiltAfterPanic) this.annPanicRecoveryExhausted = true;
        console.warn("Failed to create ANN indexes:", err);
        return false;
      }
    }
    return false;
  }

  private async createFTSIndexUnsafe(
    rebuild = false,
    retries = 5,
  ): Promise<void> {
    const table = await this.ensureTableUnsafe();
    if (rebuild) {
      this.ftsIndexEnsured = false;
      try {
        await table.dropIndex("content_idx");
      } catch {}
    }
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await table.createIndex("content", {
          config: lancedb.Index.fts({ withPosition: true }),
        });
        this.ftsIndexEnsured = true;
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("already exists")) {
          this.ftsIndexEnsured = true;
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
          this.ftsIndexEnsured = false;
          try {
            await table.dropIndex("content_idx");
            await table.createIndex("content", {
              config: lancedb.Index.fts({ withPosition: true }),
            });
            this.ftsIndexEnsured = true;
            log("vectordb", "Rebuilt FTS index with position support");
            return;
          } catch (rebuildError) {
            console.warn(
              "Failed to rebuild positional FTS index:",
              rebuildError,
            );
            throw rebuildError;
          }
        }
        console.warn("Failed to create FTS index:", e);
        throw e;
      }
    }
  }

  compactionStatus(): CompactionResult | null {
    return this.lastCompactionResult ? { ...this.lastCompactionResult } : null;
  }

  private recordSkippedCompaction(reason: string): CompactionResult {
    const result = skippedCompaction(reason);
    this.lastCompactionResult = result;
    log("vectordb", `Compaction result: ${JSON.stringify(result)}`);
    return { ...result };
  }

  /** Prune the reserve-ID snapshot without another data rewrite. Caller holds
   * compactingPromise and has drained writes; never use this for retention > 0.
   * Lance 12 treats one deletion-free fragment as a compaction no-op. */
  private async cleanupCompactionReservation(table: lancedb.Table): Promise<{
    passes: number;
    bytesRemoved: number;
    reason?: string;
    failed?: boolean;
  }> {
    let passes = 0;
    const deferred = (reason: string) => ({
      passes: 0,
      bytesRemoved: 0,
      reason,
    });
    try {
      const stats = await table.stats();
      if (stats.fragmentStats?.numFragments !== 1) {
        return deferred("cleanup deferred: table is not a single fragment");
      }
      const version = await table.version();
      const fresh = await this.openExistingTableUnsafe();
      if (!fresh || (await fresh.version()) !== version) {
        return deferred("cleanup deferred: table changed after compaction");
      }
      const latest = (await fresh.listVersions()).find(
        (v) => v.version === version,
      );
      if (
        latest?.metadata.total_fragments !== "1" ||
        latest.metadata.total_deletion_files !== "0" ||
        latest.metadata.total_deletion_file_rows !== "0"
      ) {
        return deferred(
          "cleanup deferred: deletion-free fragment not verified",
        );
      }
      // Manifest timestamps have sub-ms precision; wait for a real later tick,
      // never invent a future cutoff. No gmax writes can enter while gated.
      await new Promise((resolve) => setTimeout(resolve, 1));
      const cutoff = new Date();
      if (
        !Number.isFinite(latest.timestamp.getTime()) ||
        cutoff.getTime() <= latest.timestamp.getTime()
      ) {
        return deferred("cleanup deferred: clock has not passed the commit");
      }
      const freeBytes = this.getAvailableBytes();
      const requiredBytes = stats.totalBytes * 2 + DISK_CRITICAL_BYTES;
      if (
        !Number.isFinite(stats.totalBytes) ||
        stats.totalBytes < 0 ||
        freeBytes < requiredBytes
      ) {
        return deferred("cleanup deferred: insufficient rewrite headroom");
      }
      log(
        "vectordb",
        `Compaction cleanup attempt: ${JSON.stringify({ version, cutoff: cutoff.getTime(), freeBytes, requiredBytes })}`,
      );
      passes = 1;
      const result = await fresh.optimize({
        cleanupOlderThan: cutoff,
        deleteUnverified: true,
      });
      if (
        result.compaction.fragmentsRemoved !== 0 ||
        result.compaction.fragmentsAdded !== 0
      ) {
        return {
          passes,
          bytesRemoved: result.prune.bytesRemoved,
          failed: true,
          reason: "cleanup unexpectedly rewrote data; no retry",
        };
      }
      return { passes, bytesRemoved: result.prune.bytesRemoved };
    } catch (error) {
      return {
        passes,
        bytesRemoved: 0,
        failed: true,
        reason: `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async optimize(
    retries = COMPACTION_MAX_ATTEMPTS,
    retentionMs = 0,
    bypassExclusiveMutation = false,
  ): Promise<CompactionResult> {
    if (fullTableMaintenanceDisabled()) {
      this.lastOptimizeDidWork = false;
      return this.recordSkippedCompaction(
        recordMaintenanceContainment(this.lancedbDir),
      );
    }
    if (!bypassExclusiveMutation) {
      while (this.exclusiveMutationPromise) await this.exclusiveMutationPromise;
      if (this.closed) throw new Error("VectorDB connection is closed");
    }
    if (this.compactingPromise) {
      debug("vectordb", "Optimize already in progress, skipping");
      await this.compactingPromise;
      return (
        this.compactionStatus() ?? skippedCompaction("compaction unavailable")
      );
    }
    this.lastOptimizeDidWork = false;

    let resolveCompacting!: () => void;
    this.compactingPromise = new Promise<void>((resolve) => {
      resolveCompacting = resolve;
    });
    this.activeCompactions++;
    const startedAt = Date.now();
    let attempts = 0;
    let logicalBytes: number | undefined;
    let diskBytesBefore: number | undefined;
    let freeBytesBefore: number | undefined;
    let cleanupPasses = 0;
    let cleanupReason: string | undefined;
    const finish = (
      status: CompactionResult["status"],
      reason?: string,
      bytesReclaimed?: number,
    ): CompactionResult => {
      const diskBytesAfter = this.getDirectorySize(this.lancedbDir);
      const result: CompactionResult = {
        status,
        at: Date.now(),
        attempts,
        elapsedMs: Date.now() - startedAt,
        reason: reason?.replace(/[\r\n\t]/g, " ").slice(0, 512),
        logicalBytes,
        diskBytesBefore,
        freeBytesBefore,
        diskBytesAfter,
        freeBytesAfter: this.getAvailableBytes(),
        bytesReclaimed,
        netBytesReclaimed:
          diskBytesBefore === undefined
            ? undefined
            : diskBytesBefore - diskBytesAfter,
        cleanupPasses,
        cleanupReason,
      };
      this.lastCompactionResult = result;
      log("vectordb", `Compaction result: ${JSON.stringify(result)}`);
      return { ...result };
    };
    try {
      const maxAttempts = Math.min(retries, COMPACTION_MAX_ATTEMPTS);
      let rebuiltFts = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await this.drainWrites();

        try {
          // Open AFTER outstanding writes commit, and reopen on every retry.
          // A handle opened before drainWrites carries the old snapshot even
          // though new writes are gated. Reusing it repeats the same conflict.
          const table = await this.ensureTableUnsafe();
          const { totalBytes } = await table.stats();
          if (!Number.isFinite(totalBytes) || totalBytes < 0) {
            throw new Error("Cannot estimate compaction size from table stats");
          }
          // Bypass the cached pressure check: a failed attempt can consume a
          // whole table within its 30s cache window. Budget two logical copies
          // for rewrite/index overhead, leaving the critical reserve untouched.
          const availableBytes = this.getAvailableBytes();
          const requiredBytes = totalBytes * 2 + DISK_CRITICAL_BYTES;
          logicalBytes = totalBytes;
          const diskBytes = this.getDirectorySize(this.lancedbDir);
          diskBytesBefore ??= diskBytes;
          freeBytesBefore ??= availableBytes;
          if (availableBytes < requiredBytes) {
            const reason = `insufficient rewrite headroom (${(availableBytes / 1024 ** 3).toFixed(1)}GB free, ${(requiredBytes / 1024 ** 3).toFixed(1)}GB required)`;
            log("vectordb", `Optimize skipped: ${reason}`);
            return finish("skipped", reason);
          }
          attempts++;
          log(
            "vectordb",
            `Compaction attempt: ${JSON.stringify({ attempt, maxAttempts, logicalBytes, diskBytes, freeBytes: availableBytes, requiredBytes })}`,
          );
          const done = timer("vectordb", "optimize");
          // deleteUnverified deletes files Lance cannot prove are unreferenced.
          // LanceDB's own docs: only safe "if you can guarantee that no other
          // process is currently working on this dataset. Otherwise the dataset
          // could be put into a corrupted state." gmax is multi-process, so that
          // guarantee comes from routing compaction to a single writer — the
          // daemon serializes it (Daemon.runOptimize + the maintenance loop),
          // and CLI callers go through it rather than optimizing alongside it.
          // Anything new that calls optimize() must preserve that: either be the
          // daemon, or be the only process on the store.
          const stats = await table.optimize({
            // Include fragment copies left by earlier failed attempts.
            cleanupOlderThan: new Date(Date.now() - retentionMs),
            deleteUnverified: true,
          });
          done();
          this.ftsPanicRecoveryExhausted = false;

          const { compaction, prune } = stats;
          if (
            compaction.fragmentsRemoved > 0 ||
            prune.oldVersionsRemoved > 0 ||
            prune.bytesRemoved > 0
          ) {
            this.lastOptimizeDidWork = true;
            log(
              "vectordb",
              `Compacted: ${compaction.fragmentsRemoved} frags → ${compaction.fragmentsAdded}, ` +
                `pruned ${prune.oldVersionsRemoved} versions, ` +
                `freed ${(prune.bytesRemoved / 1024 / 1024).toFixed(1)}MB`,
            );
          } else {
            debug("vectordb", "Optimize: nothing to compact or prune");
          }
          let bytesReclaimed = prune.bytesRemoved;
          if (retentionMs === 0 && compaction.fragmentsRemoved > 0) {
            const cleanup = await this.cleanupCompactionReservation(table);
            cleanupPasses = cleanup.passes;
            cleanupReason = cleanup.reason
              ?.replace(/[\r\n\t]/g, " ")
              .slice(0, 512);
            bytesReclaimed += cleanup.bytesRemoved;
            this.lastOptimizeDidWork ||= cleanup.bytesRemoved > 0;
            log(
              "vectordb",
              `Compaction cleanup result: ${JSON.stringify({ ...cleanup, reason: cleanupReason })}`,
            );
            if (cleanup.failed)
              return finish("failed", cleanupReason, bytesReclaimed);
          }
          return finish("completed", undefined, bytesReclaimed);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("Nothing to do")) {
            debug("vectordb", "Optimize: nothing to do");
            return finish("completed", "nothing to compact or prune", 0);
          }
          log(
            "vectordb",
            `Compaction attempt failed: ${JSON.stringify({ attempt, elapsedMs: Date.now() - startedAt, diskBytes: this.getDirectorySize(this.lancedbDir), freeBytes: this.getAvailableBytes(), reason: msg.slice(0, 512) })}`,
          );
          // ENOSPC: return immediately — retrying will only make things worse
          if (
            msg.includes("No space left on device") ||
            msg.includes("os error 28")
          ) {
            log(
              "vectordb",
              `Optimize failed (ENOSPC): disk full — skipping retries`,
            );
            return finish("failed", "disk full — skipping retries");
          }
          if (
            attempt < maxAttempts &&
            (msg.includes("conflict") || msg.includes("Retryable"))
          ) {
            const delay = 1000 * 2 ** (attempt - 1);
            log(
              "vectordb",
              `Optimize conflict (attempt ${attempt}/${maxAttempts}), retrying with a fresh snapshot in ${delay}ms`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          // A Rust panic here is the lance-index inverted (FTS) merge bug
          // (out-of-bounds in scalar/inverted/builder.rs): the incremental
          // merge trips on inconsistent index state, and because optimize()
          // is all-or-nothing it blocks compaction and pruning entirely.
          // Rebuild the FTS index from scratch once and retry. Must use the
          // Unsafe variant: the public createFTSIndex waits on
          // compactingPromise, which we hold.
          if (msg.includes("Panic")) {
            if (
              attempt < maxAttempts &&
              !rebuiltFts &&
              !this.ftsPanicRecoveryExhausted
            ) {
              rebuiltFts = true;
              log(
                "vectordb",
                "Optimize panicked (likely corrupt FTS merge) — rebuilding FTS index from scratch and retrying",
              );
              try {
                this.ftsIndexEnsured = false;
                await this.createFTSIndexUnsafe(true);
                continue;
              } catch (rebuildErr) {
                this.ftsPanicRecoveryExhausted = true;
                log("vectordb", `FTS rebuild failed: ${rebuildErr}`);
                return finish("failed", `FTS rebuild failed: ${rebuildErr}`);
              }
            }
            if (rebuiltFts) {
              this.ftsPanicRecoveryExhausted = true;
              log(
                "vectordb",
                "Optimize still panicking after FTS rebuild — disabling auto-rebuild until an optimize succeeds",
              );
            }
          }
          log("vectordb", `Optimize failed: ${msg}`);
          return finish("failed", msg);
        }
      }
      return finish("skipped", "no compaction attempts requested");
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
   * Reports bloat without another whole-table rewrite.
   */
  async runMaintenance(
    options: { force?: boolean } = {},
  ): Promise<CompactionResult | undefined> {
    if (fullTableMaintenanceDisabled()) {
      this.lastOptimizeDidWork = false;
      return this.recordSkippedCompaction(
        recordMaintenanceContainment(this.lancedbDir),
      );
    }
    if (this.maintenanceRunning) {
      debug("vectordb", "Maintenance already running, skipping");
      return skippedCompaction("maintenance already running");
    }
    this.maintenanceRunning = true;
    const epochSnapshot = this.writeEpoch;
    let result: CompactionResult | undefined;
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
        return this.recordSkippedCompaction(
          `disk critically low (${freeGb}GB free)`,
        );
      }

      if (
        !options.force &&
        epochSnapshot === this.maintainedEpoch &&
        this.ftsIndexEnsured
      ) {
        const table = await this.openExistingTableUnsafe();
        const version = await this.readTableVersion(table);
        if (version === this.maintainedTableVersion) {
          this.lastMaintenanceMs = Date.now();
          return;
        }
        log(
          "vectordb",
          `External store writes detected (v${this.maintainedTableVersion} → v${version})`,
        );
      }

      await this.createFTSIndex();
      await this.createVectorIndex();

      // Index creation above is idempotent and self-guarding, so it stays on the
      // 5-minute cadence. Compaction is the expensive half — it rewrites the whole
      // table — and gets rate-limited. Without this the tick compacts every 5
      // minutes for as long as writes keep arriving, which is how this store
      // reached 43 full rewrites in two days and panicked the host.
      const throttleMs = options.force
        ? 0
        : this.compactionThrottleRemainingMs();
      if (throttleMs > 0) {
        debug(
          "vectordb",
          `Compaction throttled — ${Math.ceil(throttleMs / 60000)}min until next full pass ` +
            `(interval ${Math.round(this.compactionIntervalMs / 60000)}min)`,
        );
      } else if (pressure === "low") {
        log("vectordb", `Low disk — single-pass optimize (no bloat retry)`);
        result = await this.optimize(1, 0, true);
        this.noteCompaction(this.lastOptimizeDidWork);
      } else {
        // Normal maintenance: full optimize + bloat check
        result = await this.optimize(5, 0, true);
        // Track across both passes: `lastOptimizeDidWork` is reset per optimize()
        // call, so a productive first pass followed by a barren bloat retry would
        // otherwise read as unproductive and trigger a spurious backoff.
        const didWork = this.lastOptimizeDidWork;

        if (result.status === "completed" && this.lastOptimizeDidWork) {
          const table = await this.openExistingTableUnsafe();
          if (table) {
            // Collect abandoned scratch files before measuring. They are pure
            // disk with no manifest entry, so they inflate the ratio while being
            // invisible to optimize — measuring first would blame the compactor
            // for bytes it has no way to reach and send us into a second
            // full-table pass that reclaims nothing.
            const swept = sweepStaleLanceTempFiles(this.lancedbDir);
            if (swept.filesRemoved > 0) {
              log(
                "vectordb",
                `Swept ${swept.filesRemoved} abandoned temp file(s), freed ${(swept.bytesFreed / 1024 / 1024).toFixed(1)}MB`,
              );
            }

            const stats = await table.stats();
            const diskSize = this.getDirectorySize(this.lancedbDir);
            const logicalSize = stats.totalBytes;
            const bloatRatio = logicalSize > 0 ? diskSize / logicalSize : 0;

            if (bloatRatio > 2.0) {
              log(
                "vectordb",
                `Bloat remains after optimize: ${bloatRatio.toFixed(1)}x; additional rewrite disabled`,
              );
            }
          }
        }
        this.noteCompaction(didWork);
      }

      if (result && result.status !== "completed") return result;
      if (result?.cleanupReason) return result;
      const maintainedTable = await this.openExistingTableUnsafe();
      this.maintainedTableVersion =
        await this.readTableVersion(maintainedTable);
      this.maintainedEpoch = epochSnapshot;
      this.lastMaintenanceMs = Date.now();
      return result;
    } finally {
      this.maintenanceRunning = false;
    }
  }

  /**
   * Milliseconds until an opportunistic full-table compaction is allowed again,
   * or 0 if one may run now. Forced callers (`gmax index`, `doctor --fix`) are
   * expected to bypass this rather than consult it.
   */
  private compactionThrottleRemainingMs(now = Date.now()): number {
    if (this.lastCompactionMs === 0) return 0;
    const elapsed = now - this.lastCompactionMs;
    // A clock that jumped backwards would otherwise wedge compaction shut.
    if (elapsed < 0) return 0;
    return Math.max(0, this.compactionIntervalMs - elapsed);
  }

  /**
   * Record a completed compaction and adjust the interval. Productive passes reset
   * to the floor; unproductive ones double up to the ceiling so a store that cannot
   * be improved stops being rewritten every few minutes.
   */
  private noteCompaction(didWork: boolean): void {
    this.lastCompactionMs = Date.now();
    if (didWork) {
      if (this.compactionIntervalMs !== COMPACTION_MIN_INTERVAL_MS) {
        debug("vectordb", "Productive compaction — interval reset to floor");
      }
      this.compactionIntervalMs = COMPACTION_MIN_INTERVAL_MS;
      return;
    }
    const next = Math.min(
      this.compactionIntervalMs * 2,
      COMPACTION_MAX_INTERVAL_MS,
    );
    if (next !== this.compactionIntervalMs) {
      log(
        "vectordb",
        `Compaction reclaimed nothing — backing off to ${Math.round(next / 60000)}min`,
      );
    }
    this.compactionIntervalMs = next;
  }

  /** Test/diagnostic view of the rate limiter. */
  getCompactionThrottleState(): { intervalMs: number; remainingMs: number } {
    return {
      intervalMs: this.compactionIntervalMs,
      remainingMs: this.compactionThrottleRemainingMs(),
    };
  }

  async compactIfNeeded(
    threshold = FRAGMENT_COMPACT_THRESHOLD,
  ): Promise<boolean> {
    if (fullTableMaintenanceDisabled()) {
      this.lastOptimizeDidWork = false;
      this.recordSkippedCompaction(
        recordMaintenanceContainment(this.lancedbDir),
      );
      return false;
    }
    if (this.maintenanceRunning) return false;
    this.maintenanceRunning = true;
    try {
      if (this.checkDiskPressure() !== "ok") return false;
      const table = await this.ensureTable();
      const stats = await table.stats();
      if (stats.fragmentStats.numSmallFragments > threshold) {
        const throttleMs = this.compactionThrottleRemainingMs();
        if (throttleMs > 0) {
          debug(
            "vectordb",
            `Fragment threshold exceeded (${stats.fragmentStats.numSmallFragments} > ${threshold}) — throttled, ${Math.ceil(throttleMs / 60000)}min remaining`,
          );
          return false;
        }
        log(
          "vectordb",
          `Fragment threshold exceeded (${stats.fragmentStats.numSmallFragments} > ${threshold}) — compacting`,
        );
        const result = await this.optimize(2, 0, true);
        this.noteCompaction(this.lastOptimizeDidWork);
        return result.status === "completed";
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
    const rows = await table
      .query()
      .select(["id"])
      .limit(1)
      .toArray(QUERY_EXECUTION_OPTIONS);
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
      .toArray(QUERY_EXECUTION_OPTIONS);
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
    const rows = streamQueryRows(
      table.query().select(["path"]).where(pathStartsWith(prefix)),
      "distinct project paths",
    );
    const unique = new Set<string>();
    for await (const r of rows) {
      unique.add(String(r.path));
    }
    return unique;
  }

  /**
   * The stored embeddings of one file, keyed by `embeddingReuseKey(content)`.
   * Rows whose dense width disagrees with this table are left out rather than
   * offered — reuse must never be the way a wrong-width vector gets copied.
   */
  async getReusableEmbeddings(
    filePath: string,
  ): Promise<Map<string, ReusableEmbedding>> {
    const table = await this.ensureTable();
    const rows = await table
      .query()
      .select([
        "content",
        "vector",
        "colbert",
        "colbert_scale",
        "pooled_colbert_48d",
        "doc_token_ids",
      ])
      .where(`path = '${escapeSqlString(filePath)}'`)
      .toArray(QUERY_EXECUTION_OPTIONS);
    const reusable = new Map<string, ReusableEmbedding>();
    for (const row of rows) {
      const vector = toFloat32(row.vector);
      const colbert = toBytes(row.colbert);
      if (vector.length !== this.vectorDim || colbert.length === 0) continue;
      const pooled =
        row.pooled_colbert_48d == null
          ? undefined
          : toFloat32(row.pooled_colbert_48d);
      const tokenIds =
        row.doc_token_ids == null ? undefined : toInt32(row.doc_token_ids);
      reusable.set(embeddingReuseKey(String(row.content ?? "")), {
        vector,
        colbert,
        colbert_scale:
          typeof row.colbert_scale === "number" ? row.colbert_scale : 1,
        pooled_colbert_48d: pooled?.length ? pooled : undefined,
        doc_token_ids: tokenIds,
      });
    }
    return reusable;
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
    const paths = new Set<string>();
    for await (const row of streamQueryRows(
      table.query().select(["path"]),
      "distinct file count",
    )) {
      paths.add(String(row.path));
    }
    return paths.size;
  }

  async deletePaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const unique = Array.from(new Set(paths));
    const batchSize = 500;
    await this.withWriteGate(async () => {
      const table = await this.openExistingTableUnsafe();
      if (!table) return;
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
          .toArray(QUERY_EXECUTION_OPTIONS);
        if (existing.length > 0) {
          await table.delete(where);
          this.markWriteCommitted();
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
      this.markWriteCommitted();
    });
  }

  async deletePathsExcludingIds(
    paths: string[],
    excludeIds: string[],
  ): Promise<void> {
    if (!paths.length) return;
    const unique = Array.from(new Set(paths));
    const batchSize = 500;
    const idExclusion =
      excludeIds.length > 0
        ? ` AND id NOT IN (${excludeIds.map((id) => `'${escapeSqlString(id)}'`).join(",")})`
        : "";
    await this.withWriteGate(async () => {
      const table = await this.openExistingTableUnsafe();
      if (!table) return;
      for (let i = 0; i < unique.length; i += batchSize) {
        const slice = unique.slice(i, i + batchSize);
        const values = slice.map((p) => `'${escapeSqlString(p)}'`).join(",");
        const where = `path IN (${values})${idExclusion}`;
        const existing = await table
          .query()
          .select(["id"])
          .where(where)
          .limit(1)
          .toArray(QUERY_EXECUTION_OPTIONS);
        if (existing.length > 0) {
          await table.delete(where);
          this.markWriteCommitted();
        }
      }
    });
  }

  async deletePathsWithPrefix(prefix: string): Promise<void> {
    // Slash-terminate so a project root can't bleed into a sibling
    // (`/repo/app` must not delete `/repo/app2`), and use starts_with so `_`/`%`
    // in the path are literal, not LIKE wildcards. Destructive path — keep this
    // self-protective even if a caller forgets to normalize.
    const dirPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    await this.withWriteGate(async () => {
      const table = await this.openExistingTableUnsafe();
      if (!table) return;
      await table.delete(pathStartsWith(dirPrefix));
      this.markWriteCommitted();
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
    this.session = null;
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
