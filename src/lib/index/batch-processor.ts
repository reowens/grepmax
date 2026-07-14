import * as path from "node:path";
import type { MetaCache, MetaEntry } from "../store/meta-cache";
import type { VectorRecord } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { DiskPressureError, isLanceCorruptionError } from "../store/vector-db";
import { isFileCached } from "../utils/cache-check";
import {
  computeContentHash,
  isIndexableFile,
  readFileSnapshot,
} from "../utils/file-utils";
import { log } from "../utils/logger";
import { getWorkerPool, type WorkerPool } from "../workers/pool";
import {
  CURRENT_META_HASH_VERSION,
  isMetaEntryCacheCurrent,
} from "./cache-coherence";
import { ProjectFilePolicy } from "./file-policy";
import { computePathRetry } from "./watcher-batch";

export interface BatchProcessorOptions {
  projectRoot: string;
  vectorDb: VectorDB;
  metaCache: MetaCache;
  workerPool?: WorkerPool;
  onReindex?: (files: number, durationMs: number) => void;
  onActivity?: () => void;
  filePolicy?: ProjectFilePolicy;
  onPolicyChange?: () => void;
  onTerminalFailure?: (absPath: string) => void;
  onPathSuccess?: (absPath: string) => void;
  runOperation?: (fn: (signal: AbortSignal) => Promise<void>) => Promise<void>;
}

const DEBOUNCE_MS = 2000;
const MAX_RETRIES = 5;
const MAX_BATCH_SIZE = 50;

export class ProjectBatchProcessor {
  readonly projectRoot: string;
  private readonly vectorDb: VectorDB;
  private readonly metaCache: MetaCache;
  private readonly workerPool: WorkerPool;
  private readonly onReindex?: (files: number, durationMs: number) => void;
  private readonly onActivity?: () => void;
  private readonly onPolicyChange?: () => void;
  private readonly onTerminalFailure?: (absPath: string) => void;
  private readonly onPathSuccess?: (absPath: string) => void;
  private readonly runOperation?: BatchProcessorOptions["runOperation"];
  readonly filePolicy: ProjectFilePolicy;
  private readonly wtag: string;
  private readonly batchTimeoutMs: number;

  private readonly pending = new Map<string, "change" | "unlink">();
  private readonly retryCount = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  private readonly terminalFailures = new Set<string>();
  private readonly forcedReprocess = new Map<string, number>();
  private forceGeneration = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceDueMs = 0;
  private activeBatch: Promise<void> | null = null;
  private processing = false;
  private closed = false;
  private currentBatchAc: AbortController | null = null;
  private lastCorruptionLogMs = 0;
  private policyChangedDuringBatch = false;

  constructor(opts: BatchProcessorOptions) {
    this.projectRoot = opts.projectRoot;
    this.vectorDb = opts.vectorDb;
    this.metaCache = opts.metaCache;
    this.workerPool = opts.workerPool ?? getWorkerPool();
    this.onReindex = opts.onReindex;
    this.onActivity = opts.onActivity;
    this.onPolicyChange = opts.onPolicyChange;
    this.onTerminalFailure = opts.onTerminalFailure;
    this.onPathSuccess = opts.onPathSuccess;
    this.runOperation = opts.runOperation;
    this.filePolicy =
      opts.filePolicy ?? new ProjectFilePolicy(opts.projectRoot);
    this.wtag = `watch:${path.basename(opts.projectRoot)}`;

    const taskTimeoutMs = (() => {
      const fromEnv = Number.parseInt(
        process.env.GMAX_WORKER_TASK_TIMEOUT_MS ?? "",
        10,
      );
      return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 120_000;
    })();
    this.batchTimeoutMs = Math.max(Math.ceil(taskTimeoutMs * 1.5), 120_000);
  }

  handleFileEvent(
    event: "change" | "unlink",
    absPath: string,
    options?: { forceReprocess?: boolean; forceDelete?: boolean },
  ): void {
    if (this.closed) return;
    const normalize = (
      this.filePolicy as ProjectFilePolicy & {
        normalizeEventPath?: (candidate: string) => string | null;
      }
    ).normalizeEventPath;
    const normalized = normalize
      ? normalize.call(this.filePolicy, absPath)
      : this.filePolicy.isLexicallyContained(absPath)
        ? path.resolve(absPath)
        : null;
    if (!normalized) return;
    if (this.filePolicy.isPolicyFile(normalized) && !options?.forceDelete) {
      this.filePolicy.invalidateIgnoreCache();
      if (this.processing) this.policyChangedDuringBatch = true;
      this.onPolicyChange?.();
      return;
    }
    if (
      !isIndexableFile(normalized, 1) &&
      !this.metaCache.get(normalized) &&
      !(event === "unlink" && options?.forceDelete)
    )
      return;
    if (options?.forceReprocess) {
      this.forcedReprocess.set(normalized, ++this.forceGeneration);
    }
    this.retryAt.delete(normalized);
    this.pending.set(normalized, event);
    this.onActivity?.();
    this.scheduleBatch();
  }

  /** Live (re)index progress: files queued + whether a batch is running. */
  get progress(): {
    pendingFiles: number;
    processing: boolean;
    failedFiles: number;
  } {
    return {
      pendingFiles: this.pending.size,
      processing: this.processing,
      failedFiles: this.terminalFailures.size,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.currentBatchAc?.abort();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.debounceDueMs = 0;
    }
    if (this.activeBatch) {
      await this.activeBatch;
    }
  }

  private scheduleBatch(delayMs = DEBOUNCE_MS): void {
    const dueMs = Date.now() + Math.max(0, delayMs);
    if (this.debounceTimer && this.debounceDueMs <= dueMs) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceDueMs = dueMs;
    this.debounceTimer = setTimeout(
      () => {
        this.debounceTimer = null;
        this.debounceDueMs = 0;
        this.startBatch();
      },
      Math.max(0, delayMs),
    );
  }

  private schedulePendingBatch(defaultDelayMs = DEBOUNCE_MS): void {
    const now = Date.now();
    let earliestRetryMs = Number.POSITIVE_INFINITY;
    for (const absPath of this.pending.keys()) {
      const retryAt = this.retryAt.get(absPath) ?? 0;
      if (retryAt <= now) {
        this.scheduleBatch(defaultDelayMs);
        return;
      }
      earliestRetryMs = Math.min(earliestRetryMs, retryAt - now);
    }
    this.scheduleBatch(
      Number.isFinite(earliestRetryMs) ? earliestRetryMs : defaultDelayMs,
    );
  }

  private startBatch(): void {
    if (this.activeBatch) return;
    const execute = (signal: AbortSignal) => this.processBatch(signal);
    const run = (
      this.runOperation
        ? this.runOperation(execute)
        : execute(new AbortController().signal)
    ).catch((err) => {
      console.error(`[${this.wtag}] Batch processing failed:`, err);
    });
    this.activeBatch = run;
    void run.finally(() => {
      if (this.activeBatch === run) this.activeBatch = null;
    });
  }

  private async processBatch(operationSignal: AbortSignal): Promise<void> {
    if (this.closed || this.processing || this.pending.size === 0) return;

    const diskPressure = this.vectorDb.checkDiskPressure();
    if (diskPressure === "critical") {
      log(
        this.wtag,
        "Disk critically low — applying deletions and deferring indexing",
      );
    }

    const batch = new Map<string, "change" | "unlink">();
    const batchForceGenerations = new Map<string, number>();
    const now = Date.now();
    let taken = 0;
    for (const [absPath, event] of this.pending) {
      if ((this.retryAt.get(absPath) ?? 0) > now) continue;
      batch.set(absPath, event);
      const forceGeneration = this.forcedReprocess.get(absPath);
      if (forceGeneration !== undefined) {
        batchForceGenerations.set(absPath, forceGeneration);
      }
      taken++;
      if (taken >= MAX_BATCH_SIZE) break;
    }
    if (batch.size === 0) {
      this.schedulePendingBatch(30_000);
      return;
    }

    this.processing = true;

    const batchAc = new AbortController();
    const abortBatch = () => batchAc.abort(operationSignal.reason);
    if (operationSignal.aborted) abortBatch();
    else operationSignal.addEventListener("abort", abortBatch, { once: true });
    this.currentBatchAc = batchAc;
    const batchTimeout = setTimeout(() => {
      log(
        this.wtag,
        `Batch timed out after ${this.batchTimeoutMs}ms, aborting`,
      );
      batchAc.abort();
    }, this.batchTimeoutMs);

    for (const key of batch.keys()) {
      this.pending.delete(key);
      this.retryAt.delete(key);
    }
    const filenames = [...batch.keys()].map((p) => path.basename(p));
    log(
      this.wtag,
      `Processing ${batch.size} changed files: ${filenames.join(", ")}`,
    );

    const start = Date.now();
    let reindexed = 0;
    let processed = 0;
    let backoffOverrideMs = 0;

    try {
      // No lock needed — daemon is the single writer to LanceDB/MetaCache
      const pool = this.workerPool;
      const deletes: string[] = [];
      const vectors: VectorRecord[] = [];
      const metaUpdates = new Map<string, MetaEntry>();
      const metaDeletes: string[] = [];
      const completed = new Set<string>();
      const retryFailures = new Set<string>();
      const requeuePath = (
        absPath: string,
        event: "change" | "unlink",
        failed: boolean,
      ) => {
        if (this.pending.has(absPath)) return;
        if (failed) {
          const retry = computePathRetry(
            this.retryCount.get(absPath) ?? 0,
            MAX_RETRIES,
            DEBOUNCE_MS,
          );
          if (!retry.retry) {
            log(
              this.wtag,
              `Dropped ${path.basename(absPath)} after ${MAX_RETRIES} retries`,
            );
            this.retryCount.delete(absPath);
            this.retryAt.delete(absPath);
            this.terminalFailures.add(absPath);
            this.onTerminalFailure?.(absPath);
            return;
          }
          this.retryCount.set(absPath, retry.failures);
          this.retryAt.set(absPath, Date.now() + retry.backoffMs);
        }
        this.pending.set(absPath, event);
      };

      for (const [absPath, event] of batch) {
        if (batchAc.signal.aborted) break;
        processed++;
        if (
          batch.size > 10 &&
          (processed % 10 === 0 || processed === batch.size)
        ) {
          log(
            this.wtag,
            `Progress: ${processed}/${batch.size} (${reindexed} reindexed)`,
          );
        }

        // Reclassify every event at apply time. A catchup-derived unlink may be
        // stale if the file was recreated after its directory was scanned.
        try {
          const classification = await this.filePolicy.classifyFile(absPath);
          if (classification.status === "error") {
            console.error(
              `[${this.wtag}] Policy could not classify ${absPath}:`,
              classification.error,
            );
            retryFailures.add(absPath);
            continue;
          }
          if (
            classification.status === "excluded" ||
            classification.status === "missing"
          ) {
            if (event === "unlink" || this.metaCache.get(absPath)) {
              deletes.push(absPath);
              metaDeletes.push(absPath);
              reindexed++;
            }
            completed.add(absPath);
            continue;
          }
          const stats = classification.stat;

          if (diskPressure === "critical") {
            continue;
          }

          const cached = this.metaCache.get(absPath);
          const forceReprocess = batchForceGenerations.has(absPath);
          if (
            !forceReprocess &&
            isMetaEntryCacheCurrent(cached, absPath) &&
            isFileCached(cached, stats)
          ) {
            completed.add(absPath);
            continue;
          }

          // Fast path: if only mtime changed but size matches and we have a hash,
          // verify in-process instead of dispatching to a worker (~220ms saved).
          if (!forceReprocess && cached?.hash && cached.size === stats.size) {
            const snapshot = await readFileSnapshot(absPath, {
              projectRoot: this.projectRoot,
            });
            if (
              snapshot.size !== stats.size ||
              snapshot.mtimeMs !== stats.mtimeMs
            ) {
              throw new Error("File changed after policy classification");
            }
            const hash = computeContentHash(snapshot.buffer, absPath);
            if (hash === cached.hash) {
              metaUpdates.set(absPath, {
                ...cached,
                mtimeMs: snapshot.mtimeMs,
              });
              completed.add(absPath);
              continue;
            }
          }

          const result = await pool.processFile(
            {
              path: absPath,
              absolutePath: absPath,
              projectRoot: this.projectRoot,
            },
            batchAc.signal,
          );

          // Policy and filesystem state can change while embedding is in
          // flight. Never commit a result that no longer describes the path.
          const current = await this.filePolicy.classifyFile(absPath);
          if (current.status === "error") {
            retryFailures.add(absPath);
            continue;
          }
          if (current.status === "excluded" || current.status === "missing") {
            deletes.push(absPath);
            metaDeletes.push(absPath);
            reindexed++;
            completed.add(absPath);
            continue;
          }
          if (
            current.stat.mtimeMs !== result.mtimeMs ||
            current.stat.size !== result.size
          ) {
            retryFailures.add(absPath);
            continue;
          }

          const metaEntry: MetaEntry = {
            hash: result.hash,
            mtimeMs: result.mtimeMs,
            size: result.size,
            hashVersion: CURRENT_META_HASH_VERSION,
            hasVectors: result.vectors.length > 0,
          };

          if (
            !forceReprocess &&
            isMetaEntryCacheCurrent(cached, absPath) &&
            cached.hash === result.hash &&
            cached.hasVectors === result.vectors.length > 0
          ) {
            metaUpdates.set(absPath, metaEntry);
            completed.add(absPath);
            continue;
          }

          if (result.shouldDelete) {
            deletes.push(absPath);
            metaUpdates.set(absPath, metaEntry);
            reindexed++;
            completed.add(absPath);
            continue;
          }

          deletes.push(absPath);
          if (result.vectors.length > 0) {
            vectors.push(...result.vectors);
          }
          metaUpdates.set(absPath, metaEntry);
          reindexed++;
          completed.add(absPath);
        } catch (err) {
          if (batchAc.signal.aborted) break;
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") {
            deletes.push(absPath);
            metaDeletes.push(absPath);
            reindexed++;
            completed.add(absPath);
          } else {
            console.error(`[${this.wtag}] Failed to process ${absPath}:`, err);
            if (!pool.isHealthy()) {
              console.error(
                `[${this.wtag}] Worker pool unhealthy, aborting batch`,
              );
              break;
            }
            retryFailures.add(absPath);
          }
        }
      }

      const pureDeleteCandidates = new Set(metaDeletes);
      const authoritativeMetaDeletes = new Set<string>();
      for (const absPath of pureDeleteCandidates) {
        const current = await this.filePolicy.classifyFile(absPath);
        if (current.status === "missing" || current.status === "excluded") {
          authoritativeMetaDeletes.add(absPath);
          continue;
        }
        completed.delete(absPath);
        batch.set(absPath, "change");
        if (current.status === "error") retryFailures.add(absPath);
      }

      // Requeue files that didn't reach a terminal outcome. This includes the
      // file whose worker was in flight when the batch was aborted.
      for (const [absPath, event] of batch) {
        if (!completed.has(absPath)) {
          requeuePath(absPath, event, retryFailures.has(absPath));
        }
      }
      if (diskPressure === "critical" && this.pending.size > 0) {
        backoffOverrideMs = 60_000;
      }

      // Flush to VectorDB: insert first, then delete old (preserving new)
      const newIds = vectors.map((v) => v.id);
      if (vectors.length > 0) {
        await this.vectorDb.insertBatch(vectors);
      }
      for (const absPath of [...authoritativeMetaDeletes]) {
        const current = await this.filePolicy.classifyFile(absPath);
        if (current.status === "missing" || current.status === "excluded") {
          continue;
        }
        authoritativeMetaDeletes.delete(absPath);
        completed.delete(absPath);
        batch.set(absPath, "change");
        requeuePath(absPath, "change", current.status === "error");
      }
      const deletesToApply = deletes.filter(
        (absPath) =>
          !pureDeleteCandidates.has(absPath) ||
          authoritativeMetaDeletes.has(absPath),
      );
      if (deletesToApply.length > 0) {
        if (newIds.length > 0) {
          await this.vectorDb.deletePathsExcludingIds(deletesToApply, newIds);
        } else {
          await this.vectorDb.deletePaths(deletesToApply);
        }
      }

      // Update MetaCache
      for (const [p, entry] of metaUpdates) {
        this.metaCache.put(p, entry);
      }
      for (const p of authoritativeMetaDeletes) {
        this.metaCache.delete(p);
      }

      const duration = Date.now() - start;
      if (reindexed > 0) {
        this.onReindex?.(reindexed, duration);
      }
      const remaining = this.pending.size;
      log(
        this.wtag,
        `Batch complete: ${batch.size} files, ${reindexed} reindexed (${(duration / 1000).toFixed(1)}s)${remaining > 0 ? ` — ${remaining} remaining` : ""}`,
      );
      for (const absPath of completed) {
        const processedForce = batchForceGenerations.get(absPath);
        if (
          processedForce !== undefined &&
          this.forcedReprocess.get(absPath) === processedForce
        ) {
          this.forcedReprocess.delete(absPath);
        }
        this.retryCount.delete(absPath);
        this.retryAt.delete(absPath);
        this.terminalFailures.delete(absPath);
        this.onPathSuccess?.(absPath);
      }

      // Trigger compaction if fragments are accumulating
      if (reindexed > 0 && diskPressure !== "critical") {
        try {
          await this.vectorDb.compactIfNeeded();
        } catch (e) {
          log(this.wtag, `Post-batch compaction failed: ${e}`);
        }
      }
    } catch (err) {
      // Disk pressure: requeue without counting as retries (not the file's fault)
      const code = (err as NodeJS.ErrnoException)?.code;
      if (
        err instanceof DiskPressureError ||
        (diskPressure === "critical" && code === "ENOSPC")
      ) {
        for (const [absPath, event] of batch) {
          if (this.terminalFailures.has(absPath)) continue;
          if (!this.pending.has(absPath)) {
            this.pending.set(absPath, event);
          }
        }
        log(this.wtag, "Disk pressure — requeued batch, will retry in 60s");
        // Use batchTimeoutMs slot to signal finally not to reschedule at 2s
        backoffOverrideMs = 60_000;
      } else if (isLanceCorruptionError(err)) {
        // Manifest references a missing fragment — retrying every 2s burns CPU
        // and floods logs without making progress. Log once per hour, preserve
        // non-terminal events, and back off 30 min for manual recovery.
        const now = Date.now();
        if (now - this.lastCorruptionLogMs > 60 * 60 * 1000) {
          this.lastCorruptionLogMs = now;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[${this.wtag}] DATA CORRUPTION: LanceDB manifest references a missing fragment. ` +
              `Backing off this project's batch processor for 30 min. ` +
              `Preserve the store for diagnosis, then run 'gmax repair --rebuild' only when whole-corpus replacement is intended. Original: ${msg}`,
          );
        }
        for (const [absPath, event] of batch) {
          if (this.terminalFailures.has(absPath)) continue;
          if (!this.pending.has(absPath)) this.pending.set(absPath, event);
        }
        backoffOverrideMs = 30 * 60 * 1000;
      } else {
        console.error(`[${this.wtag}] Batch processing failed:`, err);
        let dropped = 0;
        const droppedPaths: string[] = [];
        for (const [absPath, event] of batch) {
          if (this.terminalFailures.has(absPath)) continue;
          if (this.pending.has(absPath)) continue;
          const retry = computePathRetry(
            this.retryCount.get(absPath) ?? 0,
            MAX_RETRIES,
            DEBOUNCE_MS,
          );
          if (!retry.retry) {
            this.retryCount.delete(absPath);
            this.retryAt.delete(absPath);
            this.terminalFailures.add(absPath);
            this.onTerminalFailure?.(absPath);
            dropped++;
            droppedPaths.push(absPath);
            continue;
          }
          this.retryCount.set(absPath, retry.failures);
          this.retryAt.set(absPath, Date.now() + retry.backoffMs);
          this.pending.set(absPath, event);
        }
        if (dropped > 0) {
          log(
            this.wtag,
            `Dropped ${dropped} file(s) after ${MAX_RETRIES} retries: ${droppedPaths.map((p) => path.basename(p)).join(", ")}`,
          );
        }
        backoffOverrideMs = 0;
      }
    } finally {
      clearTimeout(batchTimeout);
      operationSignal.removeEventListener("abort", abortBatch);
      this.currentBatchAc = null;
      this.processing = false;
      if (this.policyChangedDuringBatch) {
        this.policyChangedDuringBatch = false;
        for (const absPath of batch.keys()) {
          if (!this.pending.has(absPath)) {
            this.retryCount.delete(absPath);
            this.retryAt.delete(absPath);
            this.pending.set(absPath, "change");
          }
        }
      }
      if (!this.closed && this.pending.size > 0) {
        if (backoffOverrideMs > 0) {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceDueMs = Date.now() + backoffOverrideMs;
          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.debounceDueMs = 0;
            this.startBatch();
          }, backoffOverrideMs);
        } else {
          this.schedulePendingBatch();
        }
      }
    }
  }
}
