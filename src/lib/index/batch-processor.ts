import * as fs from "node:fs";
import * as path from "node:path";
import type { MetaCache, MetaEntry } from "../store/meta-cache";
import type { VectorRecord } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { INDEXABLE_EXTENSIONS } from "../../config";
import { isFileCached } from "../utils/cache-check";
import { isIndexableFile } from "../utils/file-utils";
import { log } from "../utils/logger";
import { getWorkerPool } from "../workers/pool";
import { computeRetryAction } from "./watcher-batch";

export interface BatchProcessorOptions {
  projectRoot: string;
  vectorDb: VectorDB;
  metaCache: MetaCache;
  onReindex?: (files: number, durationMs: number) => void;
  onActivity?: () => void;
}

const DEBOUNCE_MS = 2000;
const MAX_RETRIES = 5;

export class ProjectBatchProcessor {
  readonly projectRoot: string;
  private readonly vectorDb: VectorDB;
  private readonly metaCache: MetaCache;
  private readonly onReindex?: (files: number, durationMs: number) => void;
  private readonly onActivity?: () => void;
  private readonly wtag: string;
  private readonly batchTimeoutMs: number;

  private readonly pending = new Map<string, "change" | "unlink">();
  private readonly retryCount = new Map<string, number>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;
  private closed = false;
  private currentBatchAc: AbortController | null = null;

  constructor(opts: BatchProcessorOptions) {
    this.projectRoot = opts.projectRoot;
    this.vectorDb = opts.vectorDb;
    this.metaCache = opts.metaCache;
    this.onReindex = opts.onReindex;
    this.onActivity = opts.onActivity;
    this.wtag = `watch:${path.basename(opts.projectRoot)}`;

    const taskTimeoutMs = (() => {
      const fromEnv = Number.parseInt(
        process.env.GMAX_WORKER_TASK_TIMEOUT_MS ?? "",
        10,
      );
      return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 120_000;
    })();
    this.batchTimeoutMs = Math.max(
      Math.ceil(taskTimeoutMs * 1.5),
      120_000,
    );

  }

  handleFileEvent(event: "change" | "unlink", absPath: string): void {
    if (this.closed) return;
    const ext = path.extname(absPath).toLowerCase();
    const bn = path.basename(absPath).toLowerCase();
    if (!INDEXABLE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(bn))
      return;
    this.pending.set(absPath, event);
    this.onActivity?.();
    this.scheduleBatch();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.currentBatchAc?.abort();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  private scheduleBatch(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.processBatch(), DEBOUNCE_MS);
  }

  private async processBatch(): Promise<void> {
    if (this.closed || this.processing || this.pending.size === 0) return;
    this.processing = true;

    const batchAc = new AbortController();
    this.currentBatchAc = batchAc;
    const batchTimeout = setTimeout(() => {
      log(this.wtag, `Batch timed out after ${this.batchTimeoutMs}ms, aborting`);
      batchAc.abort();
    }, this.batchTimeoutMs);

    const batch = new Map(this.pending);
    this.pending.clear();
    const filenames = [...batch.keys()].map((p) => path.basename(p));
    log(this.wtag, `Processing ${batch.size} changed files: ${filenames.join(", ")}`);

    const start = Date.now();
    let reindexed = 0;

    try {
      // No lock needed — daemon is the single writer to LanceDB/MetaCache
      const pool = getWorkerPool();
      const deletes: string[] = [];
      const vectors: VectorRecord[] = [];
      const metaUpdates = new Map<string, MetaEntry>();
      const metaDeletes: string[] = [];
      const attempted = new Set<string>();

      for (const [absPath, event] of batch) {
        if (batchAc.signal.aborted) break;
        attempted.add(absPath);

        if (event === "unlink") {
          deletes.push(absPath);
          metaDeletes.push(absPath);
          reindexed++;
          continue;
        }

        // change or add
        try {
          const stats = await fs.promises.stat(absPath);
          if (!isIndexableFile(absPath, stats.size)) continue;

          const cached = this.metaCache.get(absPath);
          if (isFileCached(cached, stats)) {
            continue;
          }

          const result = await pool.processFile({
            path: absPath,
            absolutePath: absPath,
          }, batchAc.signal);

          const metaEntry: MetaEntry = {
            hash: result.hash,
            mtimeMs: result.mtimeMs,
            size: result.size,
          };

          if (cached && cached.hash === result.hash) {
            metaUpdates.set(absPath, metaEntry);
            continue;
          }

          if (result.shouldDelete) {
            deletes.push(absPath);
            metaUpdates.set(absPath, metaEntry);
            reindexed++;
            continue;
          }

          deletes.push(absPath);
          if (result.vectors.length > 0) {
            vectors.push(...result.vectors);
          }
          metaUpdates.set(absPath, metaEntry);
          reindexed++;
        } catch (err) {
          if (batchAc.signal.aborted) break;
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") {
            deletes.push(absPath);
            metaDeletes.push(absPath);
            reindexed++;
          } else {
            console.error(`[${this.wtag}] Failed to process ${absPath}:`, err);
            if (!pool.isHealthy()) {
              console.error(
                `[${this.wtag}] Worker pool unhealthy, aborting batch`,
              );
              break;
            }
          }
        }
      }

      // Requeue files that weren't attempted (aborted or pool unhealthy)
      for (const [absPath, event] of batch) {
        if (!attempted.has(absPath) && !this.pending.has(absPath)) {
          this.pending.set(absPath, event);
        }
      }

      // Flush to VectorDB: insert first, then delete old (preserving new)
      const newIds = vectors.map((v) => v.id);
      if (vectors.length > 0) {
        await this.vectorDb.insertBatch(vectors);
      }
      if (deletes.length > 0) {
        if (newIds.length > 0) {
          await this.vectorDb.deletePathsExcludingIds(deletes, newIds);
        } else {
          await this.vectorDb.deletePaths(deletes);
        }
      }

      // Update MetaCache
      for (const [p, entry] of metaUpdates) {
        this.metaCache.put(p, entry);
      }
      for (const p of metaDeletes) {
        this.metaCache.delete(p);
      }

      const duration = Date.now() - start;
      if (reindexed > 0) {
        this.onReindex?.(reindexed, duration);
      }
      log(
        this.wtag,
        `Batch complete: ${batch.size} files, ${reindexed} reindexed (${(duration / 1000).toFixed(1)}s)`,
      );
      for (const absPath of batch.keys()) {
        this.retryCount.delete(absPath);
      }
    } catch (err) {
      console.error(`[${this.wtag}] Batch processing failed:`, err);

      const { requeued, dropped, backoffMs } = computeRetryAction(
        batch,
        this.retryCount,
        MAX_RETRIES,
        false,
        0,
        DEBOUNCE_MS,
      );
      for (const [absPath, event] of requeued) {
        if (!this.pending.has(absPath)) {
          this.pending.set(absPath, event);
        }
      }
      if (dropped > 0) {
        console.warn(
          `[${this.wtag}] Dropped ${dropped} file(s) after ${MAX_RETRIES} failed retries`,
        );
      }
      if (this.pending.size > 0) {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.processBatch(), backoffMs);
      }
    } finally {
      clearTimeout(batchTimeout);
      this.currentBatchAc = null;
      this.processing = false;
      if (this.pending.size > 0) {
        this.scheduleBatch();
      }
    }
  }
}
