import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG,
  INDEXABLE_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  MODEL_IDS,
} from "../../config";
import { log, debug, timer, debugEvery } from "../utils/logger";
import { MetaCache, type MetaEntry } from "../store/meta-cache";
import type { VectorRecord } from "../store/types";
import { VectorDB } from "../store/vector-db";
// isIndexableFile no longer used — extension check inlined for performance
import { acquireWriterLockWithRetry, type LockHandle } from "../utils/lock";
import { ensureProjectPaths } from "../utils/project-root";
import { getWorkerPool } from "../workers/pool";
import type { ProcessFileResult } from "../workers/worker";
import {
  checkModelMismatch,
  readIndexConfig,
  writeIndexConfig,
} from "./index-config";
import type { InitialSyncProgress, InitialSyncResult } from "./sync-helpers";
import { walk } from "./walker";

type SyncOptions = {
  projectRoot: string;
  dryRun?: boolean;
  reset?: boolean;
  onProgress?: (info: InitialSyncProgress) => void;
  signal?: AbortSignal;
  /** Daemon mode: use shared VectorDB instead of creating a new one */
  vectorDb?: VectorDB;
  /** Daemon mode: use shared MetaCache instead of creating a new one */
  metaCache?: MetaCacheLike;
};

type MetaCacheLike = Pick<
  MetaCache,
  "get" | "getAllKeys" | "getKeysWithPrefix" | "put" | "delete" | "close"
>;

export async function generateSummaries(
  _db: VectorDB,
  _pathPrefix: string,
  _onProgress?: (count: number, total: number) => void,
  _maxChunks?: number,
): Promise<{ summarized: number; remaining: number }> {
  // LLM summarizer disabled — it loads a ~21GB model and runs unsolicited.
  return { summarized: 0, remaining: 0 };
}

async function flushBatch(
  db: VectorDB,
  meta: MetaCacheLike,
  vectors: VectorRecord[],
  pendingMeta: Map<string, MetaEntry>,
  pendingDeletes: string[],
  dryRun?: boolean,
) {
  if (dryRun) return;

  // 1. Write to VectorDB first (source of truth for data)
  if (pendingDeletes.length > 0) {
    await db.deletePaths(pendingDeletes);
  }
  if (vectors.length > 0) {
    await db.insertBatch(vectors);
  }

  // 2. Update MetaCache only after VectorDB write succeeds
  for (const [p, entry] of pendingMeta.entries()) {
    meta.put(p, entry);
  }
}

function createNoopMetaCache(): MetaCacheLike {
  const store = new Map<string, MetaEntry>();
  return {
    get: (filePath: string) => store.get(filePath),
    async getAllKeys() {
      return new Set(store.keys());
    },
    async getKeysWithPrefix(prefix: string) {
      const keys = new Set<string>();
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) keys.add(k);
      }
      return keys;
    },
    put: (filePath: string, entry: MetaEntry) => {
      store.set(filePath, entry);
    },
    delete: (filePath: string) => {
      store.delete(filePath);
    },
    close: async () => {},
  };
}

export function computeStaleFiles(
  cachedPaths: Set<string>,
  seenPaths: Set<string>,
): string[] {
  return Array.from(cachedPaths).filter((p) => !seenPaths.has(p));
}

export async function initialSync(
  options: SyncOptions,
): Promise<InitialSyncResult> {
  const {
    projectRoot,
    dryRun = false,
    reset = false,
    onProgress,
    signal,
  } = options;
  const paths = ensureProjectPaths(projectRoot);
  const resolvedRoot = path.resolve(projectRoot);
  // Path prefix for scoping — all absolute paths for this project start with this
  const rootPrefix = resolvedRoot.endsWith("/")
    ? resolvedRoot
    : `${resolvedRoot}/`;

  // Propagate project root to worker processes
  process.env.GMAX_PROJECT_ROOT = paths.root;
  const syncTimer = timer("index", "Total");
  log("index", `Root: ${resolvedRoot}`);

  // Daemon mode: caller provides shared resources, skip lock
  const injected = !!(options.vectorDb && options.metaCache);
  const ownedVectorDb = injected ? null : new VectorDB(paths.lancedbDir);
  const vectorDb = options.vectorDb ?? ownedVectorDb!;
  const treatAsEmptyCache = reset && dryRun;
  let lock: LockHandle | null = null;
  let metaCache: MetaCacheLike | null = injected ? options.metaCache! : null;

  try {
    if (!injected) {
      if (!dryRun) {
        lock = await acquireWriterLockWithRetry(paths.dataDir);
        // Open MetaCache only after lock is acquired
        metaCache = new MetaCache(paths.lmdbPath);
      } else {
        metaCache = createNoopMetaCache();
      }
    }

    // At this point metaCache is always initialized (injected, created, or noop)
    const mc = metaCache!;

    if (!dryRun) {
      // Scope checks to this project's paths only
      const projectKeys = await mc.getKeysWithPrefix(rootPrefix);
      log("index", `Cached files: ${projectKeys.size}`);

      // Coherence check: if LMDB has substantially more entries than LanceDB
      // has distinct files, the vector store is out of sync (e.g. batch
      // timeouts wrote MetaCache but not vectors, compaction failure, etc.).
      // Clear the stale cache entries so those files get re-embedded.
      const vectorFileCount = await vectorDb.countDistinctFilesForPath(rootPrefix);
      if (projectKeys.size > 0) {
        const pct = Math.round((vectorFileCount / projectKeys.size) * 100);
        log("index", `Coherence: ${vectorFileCount} vectors / ${projectKeys.size} cached (${pct}%)`);
      }
      if (projectKeys.size > 0 && vectorFileCount === 0) {
        log("index", `Stale cache detected: ${projectKeys.size} cached files but no vectors — clearing cache`);
        for (const key of projectKeys) {
          mc.delete(key);
        }
        projectKeys.clear();
      } else if (projectKeys.size > 0 && vectorFileCount < projectKeys.size * 0.8) {
        log("index", `Partial cache detected: ${vectorFileCount} files in vectors vs ${projectKeys.size} in cache — clearing cache to re-embed missing files`);
        for (const key of projectKeys) {
          mc.delete(key);
        }
        projectKeys.clear();
      }

      const modelChanged = checkModelMismatch(paths.configPath);

      if (reset || modelChanged) {
        if (modelChanged) {
          const stored = readIndexConfig(paths.configPath);
          log("index", `Reset: model changed (${stored?.embedModel} → ${MODEL_IDS.embed})`);
        } else {
          log("index", "Reset: --reset flag");
        }
        // Only delete this project's data from the centralized store
        await vectorDb.deletePathsWithPrefix(rootPrefix);
        for (const key of projectKeys) {
          mc.delete(key);
        }
      }
    }

    let total = 0;
    onProgress?.({ processed: 0, indexed: 0, total, filePath: "Scanning..." });

    const pool = getWorkerPool();

    // Pre-flight: verify embedding pipeline is functional
    const embedMode = process.env.GMAX_EMBED_MODE || "auto";
    if (embedMode !== "cpu") {
      const { isMlxUp } = await import("../workers/embeddings/mlx-client");
      const mlxReady = await isMlxUp();
      if (!mlxReady) {
        log("index", "WARNING: MLX embed server not running — using CPU embeddings (slower)");
      }
    }

    // Get only this project's cached paths (scoped by prefix)
    const cachedPaths =
      dryRun || treatAsEmptyCache
        ? new Set<string>()
        : await mc.getKeysWithPrefix(rootPrefix);
    const seenPaths = new Set<string>();
    const visitedRealPaths = new Set<string>();
    const batch: VectorRecord[] = [];
    const pendingMeta = new Map<string, MetaEntry>();
    const pendingDeletes = new Set<string>();
    // Use a large flush batch to reduce LanceDB fragment count during sync.
    // 24 vectors/flush creates ~834 fragments for 10K chunks; 2000 creates ~5.
    const batchLimit = 2000;
    const maxConcurrency = Math.max(1, CONFIG.WORKER_THREADS);

    const activeTasks: Promise<void>[] = [];
    let processed = 0;
    let indexed = 0;
    let failedFiles = 0;
    let cacheHits = 0;
    let walkedFiles = 0;
    const walkTimer = timer("index", "Walk");
    let shouldSkipCleanup = false;
    let flushError: unknown;
    let flushPromise: Promise<void> | null = null;
    let flushLock: Promise<void> = Promise.resolve();
    let flushCount = 0;

    const markProgress = (filePath: string) => {
      onProgress?.({ processed, indexed, total, filePath });
    };

    const flush = async (force = false) => {
      const shouldFlush =
        force ||
        batch.length >= batchLimit ||
        pendingDeletes.size >= batchLimit ||
        pendingMeta.size >= batchLimit;
      if (!shouldFlush) return;

      const runFlush = async () => {
        const toWrite = batch.splice(0);
        const metaEntries = new Map(pendingMeta);
        const deletes = Array.from(pendingDeletes);
        pendingMeta.clear();
        pendingDeletes.clear();

        debug("index", `flush: ${toWrite.length} vectors, ${deletes.length} deletes, ${metaEntries.size} meta`);
        const flushStart = Date.now();
        const currentFlush = flushBatch(
          vectorDb,
          mc,
          toWrite,
          metaEntries,
          deletes,
          dryRun,
        );

        flushPromise = currentFlush;
        try {
          await currentFlush;
          debug("index", `flush done: ${Date.now() - flushStart}ms`);
          flushCount++;
          // Periodically compact during sync to prevent fragment accumulation
          if (flushCount % 10 === 0) {
            await vectorDb.compactIfNeeded(30);
          }
        } catch (err) {
          debug("index", `flush error: ${err}`);
          flushError = err;
          shouldSkipCleanup = true;
          throw err;
        } finally {
          if (flushPromise === currentFlush) {
            flushPromise = null;
          }
        }
      };

      flushLock = flushLock.then(runFlush);
      await flushLock;
    };

    const isTimeoutError = (err: unknown) =>
      err instanceof Error && err.message?.toLowerCase().includes("timed out");

    const processFileWithRetry = async (
      absPath: string,
    ): Promise<ProcessFileResult> => {
      let retries = 0;
      while (true) {
        try {
          return await pool.processFile({
            path: absPath,
            absolutePath: absPath,
          });
        } catch (err) {
          if (isTimeoutError(err) && retries === 0) {
            retries += 1;
            continue;
          }
          throw err;
        }
      }
    };

    const walkProgress = debugEvery("index", 100);

    const schedule = async (task: () => Promise<void>) => {
      const taskPromise = task();
      activeTasks.push(taskPromise);
      taskPromise.finally(() => {
        const idx = activeTasks.indexOf(taskPromise);
        if (idx !== -1) activeTasks.splice(idx, 1);
      });
      if (activeTasks.length >= maxConcurrency) {
        debug("index", `schedule: active=${activeTasks.length}/${maxConcurrency} waiting for slot`);
        await Promise.race(activeTasks);
      }
    };

    for await (const relPath of walk(paths.root, {
      additionalPatterns: ["**/.git/**", "**/.gmax/**"],
    })) {
      if (signal?.aborted) {
        log("index", "abort signal received during walk");
        shouldSkipCleanup = true;
        break;
      }

      const absPath = path.join(paths.root, relPath);

      // Extension check only — no stat syscall
      const ext = path.extname(absPath).toLowerCase();
      const basename = path.basename(absPath).toLowerCase();
      if (
        !INDEXABLE_EXTENSIONS.has(ext) &&
        !INDEXABLE_EXTENSIONS.has(basename)
      ) {
        continue;
      }
      walkedFiles++;
      walkProgress(`walk: ${walkedFiles} found, ${processed} processed, ${indexed} indexed, ${cacheHits} cached, ${failedFiles} failed`);

      await schedule(async () => {
        if (signal?.aborted) {
          shouldSkipCleanup = true;
          return;
        }

        try {
          // Stat + symlink dedup (lstat to detect symlinks without resolving)
          const stats = await fs.promises.lstat(absPath);
          if (stats.isSymbolicLink()) {
            try {
              const realPath = await fs.promises.realpath(absPath);
              if (visitedRealPaths.has(realPath)) return;
              visitedRealPaths.add(realPath);
            } catch {
              return; // Broken symlink
            }
          }
          if (!stats.isFile() || stats.size === 0 || stats.size > MAX_FILE_SIZE_BYTES) {
            return;
          }

          // Use absolute path as the key for MetaCache
          const cached = treatAsEmptyCache
            ? undefined
            : mc.get(absPath);

          if (
            cached &&
            cached.mtimeMs === stats.mtimeMs &&
            cached.size === stats.size
          ) {
            cacheHits++;
            debug("index", `file ${relPath}: cached`);
            processed += 1;
            seenPaths.add(absPath);
            markProgress(relPath);
            return;
          }

          debug("index", `file ${relPath}: embedding...`);
          const result = await processFileWithRetry(absPath);

          const metaEntry: MetaEntry = {
            hash: result.hash,
            mtimeMs: result.mtimeMs,
            size: result.size,
          };

          if (result.shouldDelete) {
            debug("index", `file ${relPath}: non-indexable (delete)`);
            if (!dryRun) {
              pendingDeletes.add(absPath);
              pendingMeta.set(absPath, metaEntry);
              await flush(false);
            }
            processed += 1;
            seenPaths.add(absPath);
            markProgress(relPath);
            return;
          }

          if (cached && cached.hash === result.hash) {
            debug("index", `file ${relPath}: hash unchanged`);
            if (!dryRun) {
              mc.put(absPath, metaEntry);
            }
            processed += 1;
            seenPaths.add(absPath);
            markProgress(relPath);
            return;
          }

          if (dryRun) {
            processed += 1;
            indexed += 1;
            seenPaths.add(absPath);
            markProgress(relPath);
            return;
          }

          pendingDeletes.add(absPath);

          if (result.vectors.length > 0) {
            debug("index", `file ${relPath}: indexed ${result.vectors.length} vectors`);
            batch.push(...result.vectors);
            pendingMeta.set(absPath, metaEntry);
            indexed += 1;
          } else {
            debug("index", `file ${relPath}: 0 vectors (meta only)`);
            pendingMeta.set(absPath, metaEntry);
          }

          seenPaths.add(absPath);
          processed += 1;
          markProgress(relPath);

          await flush(false);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") {
            // Treat missing files as deletions.
            pendingDeletes.add(absPath);
            pendingMeta.delete(absPath);
            if (!dryRun) {
              mc.delete(absPath);
            }
            processed += 1;
            markProgress(relPath);
            await flush(false);
            return;
          }
          failedFiles += 1;
          processed += 1;
          seenPaths.add(absPath);
          console.error(`[sync] Failed to process ${relPath}:`, err);
          markProgress(relPath);
        }
      });
    }

    await Promise.allSettled(activeTasks);
    walkTimer();
    log("index", `Walk: ${walkedFiles} files`);
    log("index", `Embed: ${indexed} new, ${cacheHits} cached, ${failedFiles} failed`);

    if (signal?.aborted) {
      shouldSkipCleanup = true;
    }

    await flush(true);

    if (flushError) {
      throw flushError instanceof Error
        ? flushError
        : new Error(String(flushError));
    }

    // Stale cleanup: only remove paths scoped to this project's root.
    // If MetaCache was cleared (coherence check), fall back to LanceDB paths
    // so we can still detect orphaned vectors from absorbed/removed sub-projects.
    let staleSource = cachedPaths;
    if (staleSource.size === 0 && !dryRun && !shouldSkipCleanup) {
      log("index", "MetaCache empty — querying LanceDB for stale path detection");
      staleSource = await vectorDb.getDistinctPathsForPrefix(rootPrefix);
    }
    const stale = computeStaleFiles(staleSource, seenPaths);
    if (!dryRun && stale.length > 0 && !shouldSkipCleanup) {
      log("index", `Stale cleanup: ${stale.length} paths`);
      await vectorDb.deletePaths(stale);
      stale.forEach((p) => {
        mc.delete(p);
      });
    }

    // Only rebuild FTS index if data actually changed
    if (!dryRun && (indexed > 0 || stale.length > 0)) {
      const ftsTimer = timer("index", "FTS");
      onProgress?.({
        processed,
        indexed,
        total,
        filePath: "Creating FTS index...",
      });
      await vectorDb.runMaintenance();
      ftsTimer();
    }

    syncTimer();

    // Write model config so future runs can detect model changes
    if (!dryRun) {
      writeIndexConfig(paths.configPath);
    }

    // Finalize total so callers can display a meaningful summary.
    total = processed;
    return { processed, indexed, total, failedFiles };
  } finally {
    if (lock) {
      await lock.release();
    }
    // Only close resources we own (not injected by daemon)
    if (!injected) {
      await metaCache?.close();
      await ownedVectorDb?.close();
    }
  }
}
