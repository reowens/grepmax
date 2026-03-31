import * as fs from "node:fs";
import * as path from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { MetaCache, MetaEntry } from "../store/meta-cache";
import type { VectorRecord } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { INDEXABLE_EXTENSIONS } from "../../config";
import { isFileCached } from "../utils/cache-check";
import { isIndexableFile } from "../utils/file-utils";
import { log } from "../utils/logger";
import { acquireWriterLockWithRetry } from "../utils/lock";
import { getWorkerPool } from "../workers/pool";
import { computeRetryAction } from "./watcher-batch";

export interface WatcherHandle {
  close: () => Promise<void>;
}

interface WatcherOptions {
  projectRoot: string;
  vectorDb: VectorDB;
  metaCache: MetaCache;
  dataDir: string;
  onReindex?: (files: number, durationMs: number) => void;
}

// Chokidar ignored — must exclude heavy directories to keep FD count low.
// On macOS, chokidar uses FSEvents (single FD) but falls back to fs.watch()
// (one FD per directory) if FSEvents isn't available or for some subdirs.
export const WATCHER_IGNORE_PATTERNS: Array<string | RegExp> = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.gmax/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/__pycache__/**",
  "**/coverage/**",
  "**/venv/**",
  "**/.next/**",
  "**/lancedb/**",
  /(^|[/\\])\../, // dotfiles
];

const DEBOUNCE_MS = 2000;
const FTS_REBUILD_INTERVAL_MS = 5 * 60 * 1000;

export function startWatcher(opts: WatcherOptions): WatcherHandle {
  const { projectRoot, vectorDb, metaCache, dataDir, onReindex } = opts;
  const projectName = path.basename(projectRoot);
  const wtag = `watch:${projectName}`;
  const pending = new Map<string, "change" | "unlink">();
  const retryCount = new Map<string, number>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let processing = false;
  let closed = false;
  let consecutiveLockFailures = 0;
  let currentBatchAc: AbortController | null = null;
  const MAX_RETRIES = 5;

  // macOS: FSEvents is a single-FD kernel API — no EMFILE risk and no polling.
  // Linux: inotify is event-driven but uses one FD per watch; fall back to
  //        polling for monorepos to avoid hitting ulimit.
  // Override with GMAX_WATCH_POLL=1 to force polling on any platform.
  const forcePoll = process.env.GMAX_WATCH_POLL === "1";
  const usePoll = forcePoll || process.platform !== "darwin";

  const watcher: FSWatcher = watch(projectRoot, {
    ignored: WATCHER_IGNORE_PATTERNS,
    ignoreInitial: true,
    persistent: true,
    ...(usePoll
      ? { usePolling: true, interval: 5000, binaryInterval: 10000 }
      : {}),
  });

  watcher.on("error", (err) => {
    console.error(`[${wtag}] Watcher error:`, err);
  });

  const scheduleBatch = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => processBatch(), DEBOUNCE_MS);
  };

  const taskTimeoutMs = (() => {
      const fromEnv = Number.parseInt(
        process.env.GMAX_WORKER_TASK_TIMEOUT_MS ?? "",
        10,
      );
      return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 120_000;
    })();
    const BATCH_TIMEOUT_MS = Math.max(
      Math.ceil(taskTimeoutMs * 1.5),
      120_000,
    );

  const processBatch = async () => {
    if (closed || processing || pending.size === 0) return;
    processing = true;

    const batchAc = new AbortController();
    currentBatchAc = batchAc;
    const batchTimeout = setTimeout(() => {
      log(wtag, `Batch timed out after ${BATCH_TIMEOUT_MS}ms, aborting`);
      batchAc.abort();
    }, BATCH_TIMEOUT_MS);

    const batch = new Map(pending);
    pending.clear();
    const filenames = [...batch.keys()].map((p) => path.basename(p));
    log(wtag, `Processing ${batch.size} changed files: ${filenames.join(", ")}`);

    const start = Date.now();
    let reindexed = 0;

    try {
      const lock = await acquireWriterLockWithRetry(dataDir, {
        maxRetries: 3,
        retryDelayMs: 500,
      });

      try {
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

            // Quick mtime/size check — skip worker pool if unchanged
            const cached = metaCache.get(absPath);
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

            // Delete old vectors, insert new
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
              console.error(`[${wtag}] Failed to process ${absPath}:`, err);
              if (!pool.isHealthy()) {
                console.error(
                  `[${wtag}] Worker pool unhealthy, aborting batch`,
                );
                break;
              }
            }
          }
        }

        // Requeue files that weren't attempted (aborted or pool unhealthy)
        for (const [absPath, event] of batch) {
          if (!attempted.has(absPath) && !pending.has(absPath)) {
            pending.set(absPath, event);
          }
        }

        // Flush to VectorDB: insert first, then delete old (preserving new)
        const newIds = vectors.map((v) => v.id);
        if (vectors.length > 0) {
          await vectorDb.insertBatch(vectors);
        }
        if (deletes.length > 0) {
          if (newIds.length > 0) {
            await vectorDb.deletePathsExcludingIds(deletes, newIds);
          } else {
            await vectorDb.deletePaths(deletes);
          }
        }

        // Update MetaCache
        for (const [p, entry] of metaUpdates) {
          metaCache.put(p, entry);
        }
        for (const p of metaDeletes) {
          metaCache.delete(p);
        }

      } finally {
        await lock.release();
      }

      const duration = Date.now() - start;
      if (reindexed > 0) {
        onReindex?.(reindexed, duration);
      }
      log(
        wtag,
        `Batch complete: ${batch.size} files, ${reindexed} reindexed (${(duration / 1000).toFixed(1)}s)`,
      );
      consecutiveLockFailures = 0;
      for (const absPath of batch.keys()) {
        retryCount.delete(absPath);
      }
    } catch (err) {
      const isLockError =
        err instanceof Error && err.message.includes("lock already held");
      if (isLockError) {
        consecutiveLockFailures++;
      }
      console.error(`[${wtag}] Batch processing failed:`, err);

      const { requeued, dropped, backoffMs } = computeRetryAction(
        batch,
        retryCount,
        MAX_RETRIES,
        isLockError,
        consecutiveLockFailures,
        DEBOUNCE_MS,
      );
      for (const [absPath, event] of requeued) {
        if (!pending.has(absPath)) {
          pending.set(absPath, event);
        }
      }
      if (dropped > 0) {
        console.warn(
          `[${wtag}] Dropped ${dropped} file(s) after ${MAX_RETRIES} failed retries`,
        );
      }
      if (pending.size > 0) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => processBatch(), backoffMs);
      }
    } finally {
      clearTimeout(batchTimeout);
      currentBatchAc = null;
      processing = false;
      // Process any events that came in while we were processing
      if (pending.size > 0) {
        scheduleBatch();
      }
    }

  };

  const onFileEvent = (event: "change" | "unlink", absPath: string) => {
    if (closed) return;
    if (event !== "unlink") {
      const ext = path.extname(absPath).toLowerCase();
      const bn = path.basename(absPath).toLowerCase();
      if (!INDEXABLE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(bn))
        return;
    }
    pending.set(absPath, event);
    scheduleBatch();
  };

  watcher.on("add", (p) => onFileEvent("change", p));
  watcher.on("change", (p) => onFileEvent("change", p));
  watcher.on("unlink", (p) => onFileEvent("unlink", p));

  // Periodic FTS rebuild
  const ftsInterval = setInterval(async () => {
    if (closed || processing) return;
    try {
      await vectorDb.createFTSIndex();
    } catch (err) {
      console.error(`[${wtag}] FTS rebuild failed:`, err);
    }
  }, FTS_REBUILD_INTERVAL_MS);
  ftsInterval.unref();

  return {
    close: async () => {
      closed = true;
      currentBatchAc?.abort();
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(ftsInterval);
      await watcher.close();
    },
  };
}
