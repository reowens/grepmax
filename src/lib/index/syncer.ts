import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG,
  INDEXABLE_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  MODEL_IDS,
} from "../../config";
import { log, debug, timer } from "../utils/logger";
import { MetaCache, type MetaEntry } from "../store/meta-cache";
import type { VectorRecord } from "../store/types";
import { VectorDB } from "../store/vector-db";
import { escapeSqlString } from "../utils/filter-builder";
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
};

type MetaCacheLike = Pick<
  MetaCache,
  "get" | "getAllKeys" | "getKeysWithPrefix" | "put" | "delete" | "close"
>;

export async function generateSummaries(
  db: VectorDB,
  pathPrefix: string,
  onProgress?: (count: number, total: number) => void,
  maxChunks?: number,
): Promise<{ summarized: number; remaining: number }> {
  let summarizeChunks: typeof import("../workers/summarize/llm-client").summarizeChunks;
  try {
    const mod = await import("../workers/summarize/llm-client");
    summarizeChunks = mod.summarizeChunks;
  } catch {
    return { summarized: 0, remaining: 0 };
  }

  // Quick availability check
  const test = await summarizeChunks([
    { code: "test", language: "ts", file: "test" },
  ]);
  if (!test) return { summarized: 0, remaining: 0 };

  const queryLimit = maxChunks ?? 50000;
  const table = await db.ensureTable();
  const whereFilter = `path LIKE '${escapeSqlString(pathPrefix)}%' AND (summary IS NULL OR summary = '')`;
  const PAGE_SIZE = 500;
  const BATCH_SIZE = 5;

  let summarized = 0;
  let pageOffset = 0;
  let totalProcessed = 0;
  let aborted = false;

  while (totalProcessed < queryLimit) {
    const pageSize = Math.min(PAGE_SIZE, queryLimit - totalProcessed);
    const rows = await table
      .query()
      .select(["id", "path", "content", "defined_symbols"])
      .where(whereFilter)
      .limit(pageSize)
      .offset(pageOffset)
      .toArray();

    if (rows.length === 0) break;
    pageOffset += rows.length;
    totalProcessed += rows.length;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const chunks = batch.map((r: any) => {
        const defs = Array.isArray(r.defined_symbols)
          ? r.defined_symbols.filter((s: unknown) => typeof s === "string")
          : typeof r.defined_symbols?.toArray === "function"
            ? r.defined_symbols.toArray()
            : [];
        return {
          code: String(r.content || ""),
          language:
            path.extname(String(r.path || "")).replace(/^\./, "") || "unknown",
          file: String(r.path || ""),
          symbols: defs as string[],
        };
      });

      const summaries = await summarizeChunks(chunks);
      if (!summaries) {
        aborted = true;
        break;
      }

      const ids: string[] = [];
      const values: string[] = [];
      for (let j = 0; j < batch.length; j++) {
        if (summaries[j]) {
          ids.push(String((batch[j] as any).id));
          values.push(summaries[j]);
        }
      }

      if (ids.length > 0) {
        await db.updateRows(ids, "summary", values);
        summarized += ids.length;
      }

      onProgress?.(summarized, totalProcessed);
    }

    if (aborted) break;
  }

  const remaining = totalProcessed >= queryLimit
    ? queryLimit - summarized
    : 0;
  return { summarized, remaining };
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

  let lock: LockHandle | null = null;
  const vectorDb = new VectorDB(paths.lancedbDir);
  const treatAsEmptyCache = reset && dryRun;
  let metaCache: MetaCacheLike | null = null;

  try {
    if (!dryRun) {
      lock = await acquireWriterLockWithRetry(paths.dataDir);
      // Open MetaCache only after lock is acquired
      metaCache = new MetaCache(paths.lmdbPath);
    } else {
      metaCache = createNoopMetaCache();
    }

    if (!dryRun) {
      // Scope checks to this project's paths only
      const projectKeys = await metaCache.getKeysWithPrefix(rootPrefix);
      log("index", `Cached files: ${projectKeys.size}`);

      // Coherence check: if LMDB has entries but LanceDB has no vectors for
      // this project, the vector store was wiped (e.g. compaction failure,
      // manual cleanup). Clear the stale cache so files get re-embedded.
      if (projectKeys.size > 0 && !(await vectorDb.hasRowsForPath(rootPrefix))) {
        log("index", `Stale cache detected: ${projectKeys.size} cached files but no vectors — clearing cache`);
        for (const key of projectKeys) {
          metaCache.delete(key);
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
          metaCache.delete(key);
        }
      }
    }

    let total = 0;
    onProgress?.({ processed: 0, indexed: 0, total, filePath: "Scanning..." });

    const pool = getWorkerPool();
    // Get only this project's cached paths (scoped by prefix)
    const cachedPaths =
      dryRun || treatAsEmptyCache
        ? new Set<string>()
        : await metaCache.getKeysWithPrefix(rootPrefix);
    const seenPaths = new Set<string>();
    const visitedRealPaths = new Set<string>();
    const batch: VectorRecord[] = [];
    const pendingMeta = new Map<string, MetaEntry>();
    const pendingDeletes = new Set<string>();
    const batchLimit = Math.max(1, CONFIG.EMBED_BATCH_SIZE);
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

        const currentFlush = flushBatch(
          vectorDb,
          metaCache!, // Non-null assertion: metaCache is assigned after lock
          toWrite,
          metaEntries,
          deletes,
          dryRun,
        );

        flushPromise = currentFlush;
        try {
          await currentFlush;
        } catch (err) {
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

    const schedule = async (task: () => Promise<void>) => {
      const taskPromise = task();
      activeTasks.push(taskPromise);
      taskPromise.finally(() => {
        const idx = activeTasks.indexOf(taskPromise);
        if (idx !== -1) activeTasks.splice(idx, 1);
      });
      if (activeTasks.length >= maxConcurrency) {
        await Promise.race(activeTasks);
      }
    };

    for await (const relPath of walk(paths.root, {
      additionalPatterns: ["**/.git/**", "**/.gmax/**", "**/.osgrep/**"],
    })) {
      if (signal?.aborted) {
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
            : metaCache!.get(absPath);

          if (
            cached &&
            cached.mtimeMs === stats.mtimeMs &&
            cached.size === stats.size
          ) {
            cacheHits++;
            debug("index", `SKIP ${relPath} (cached)`);
            processed += 1;
            seenPaths.add(absPath);
            markProgress(relPath);
            return;
          }

          debug("index", `EMBED ${relPath}`);
          const result = await processFileWithRetry(absPath);

          const metaEntry: MetaEntry = {
            hash: result.hash,
            mtimeMs: result.mtimeMs,
            size: result.size,
          };

          if (result.shouldDelete) {
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
            if (!dryRun) {
              metaCache!.put(absPath, metaEntry);
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
            batch.push(...result.vectors);
            pendingMeta.set(absPath, metaEntry);
            indexed += 1;
          } else {
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
              metaCache!.delete(absPath);
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

    // Stale cleanup: only remove paths scoped to this project's root
    const stale = computeStaleFiles(cachedPaths, seenPaths);
    if (!dryRun && stale.length > 0 && !shouldSkipCleanup) {
      log("index", `Stale cleanup: ${stale.length} paths`);
      await vectorDb.deletePaths(stale);
      stale.forEach((p) => {
        metaCache!.delete(p);
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
      await vectorDb.createFTSIndex();
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
    await metaCache?.close();
    await vectorDb.close();
  }
}
