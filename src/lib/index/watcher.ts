import * as fs from "node:fs";
import * as path from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { MetaCache, MetaEntry } from "../store/meta-cache";
import type { VectorRecord } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { isIndexableFile } from "../utils/file-utils";
import { acquireWriterLockWithRetry } from "../utils/lock";
import { getWorkerPool } from "../workers/pool";

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
  const pending = new Map<string, "change" | "unlink">();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let processing = false;
  let closed = false;

  const watcher: FSWatcher = watch(projectRoot, {
    ignored: WATCHER_IGNORE_PATTERNS,
    ignoreInitial: true,
    persistent: true,
    // Use polling to avoid EMFILE in large monorepos.
    // fs.watch() uses one FD per directory (kqueue on macOS) and hits ulimit.
    // Polling 2-3k source files every 5s is negligible CPU.
    usePolling: true,
    interval: 5000,
    binaryInterval: 10000,
  });

  watcher.on("error", (err) => {
    console.error("[watch] Watcher error:", err);
  });

  const scheduleBatch = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => processBatch(), DEBOUNCE_MS);
  };

  const processBatch = async () => {
    if (closed || processing || pending.size === 0) return;
    processing = true;

    const batch = new Map(pending);
    pending.clear();

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

        for (const [absPath, event] of batch) {
          const relPath = path.relative(projectRoot, absPath);

          if (event === "unlink") {
            deletes.push(relPath);
            metaDeletes.push(relPath);
            reindexed++;
            continue;
          }

          // change or add
          try {
            const stats = await fs.promises.stat(absPath);
            if (!isIndexableFile(absPath, stats.size)) continue;

            // Check if content actually changed via hash
            const cached = metaCache.get(relPath);
            const result = await pool.processFile({
              path: relPath,
              absolutePath: absPath,
            });

            const metaEntry: MetaEntry = {
              hash: result.hash,
              mtimeMs: result.mtimeMs,
              size: result.size,
            };

            if (cached && cached.hash === result.hash) {
              // Content unchanged (mtime changed but hash same) — just update meta
              metaUpdates.set(relPath, metaEntry);
              continue;
            }

            if (result.shouldDelete) {
              deletes.push(relPath);
              metaUpdates.set(relPath, metaEntry);
              reindexed++;
              continue;
            }

            // Delete old vectors, insert new
            deletes.push(relPath);
            if (result.vectors.length > 0) {
              vectors.push(...result.vectors);
            }
            metaUpdates.set(relPath, metaEntry);
            reindexed++;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT") {
              deletes.push(relPath);
              metaDeletes.push(relPath);
              reindexed++;
            } else {
              console.error(`[watch] Failed to process ${relPath}:`, err);
            }
          }
        }

        // Flush to VectorDB
        if (deletes.length > 0) {
          await vectorDb.deletePaths(deletes);
        }
        if (vectors.length > 0) {
          await vectorDb.insertBatch(vectors);
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

      if (reindexed > 0) {
        const duration = Date.now() - start;
        onReindex?.(reindexed, duration);
      }
    } catch (err) {
      console.error("[watch] Batch processing failed:", err);
      // Re-queue failed items for retry
      for (const [absPath, event] of batch) {
        if (!pending.has(absPath)) {
          pending.set(absPath, event);
        }
      }
      scheduleBatch();
    } finally {
      processing = false;
      // Process any events that came in while we were processing
      if (pending.size > 0) {
        scheduleBatch();
      }
    }
  };

  const onFileEvent = (event: "change" | "unlink", absPath: string) => {
    if (closed) return;
    if (event !== "unlink" && !isIndexableFile(absPath)) return;
    pending.set(absPath, event);
    scheduleBatch();
  };

  watcher.on("add", (p) => onFileEvent("change", p));
  watcher.on("change", (p) => onFileEvent("change", p));
  watcher.on("unlink", (p) => onFileEvent("unlink", p));

  // Periodic FTS rebuild
  const ftsInterval = setInterval(async () => {
    if (closed) return;
    try {
      await vectorDb.createFTSIndex();
    } catch (err) {
      console.error("[watch] FTS rebuild failed:", err);
    }
  }, FTS_REBUILD_INTERVAL_MS);
  ftsInterval.unref();

  return {
    close: async () => {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(ftsInterval);
      await watcher.close();
    },
  };
}
