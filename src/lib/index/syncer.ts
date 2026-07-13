import * as path from "node:path";
import { CONFIG } from "../../config";
import { MetaCache, type MetaEntry } from "../store/meta-cache";
import type { VectorRecord } from "../store/types";
import { VectorDB } from "../store/vector-db";
import { isFileCached } from "../utils/cache-check";
import { acquireWriterLockWithRetry, type LockHandle } from "../utils/lock";
import { debug, debugEvery, log, timer } from "../utils/logger";
import { getProject } from "../utils/project-registry";
import { ensureProjectPaths } from "../utils/project-root";
import { getWorkerPool, type WorkerPool } from "../workers/pool";
import type { ProcessFileResult } from "../workers/worker";
import {
  CURRENT_META_HASH_VERSION,
  reconcileMetaEntry,
} from "./cache-coherence";
import {
  compareEmbeddingGeneration,
  type EmbeddingGenerationConfig,
  resolveEmbeddingGeneration,
} from "./embedding-generation";
import { ProjectFilePolicy } from "./file-policy";
import { readGlobalConfig } from "./index-config";
import type { InitialSyncProgress, InitialSyncResult } from "./sync-helpers";
import { createWalkState, isPathProtectedByWalkState, walk } from "./walker";

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
  generation?: Readonly<EmbeddingGenerationConfig>;
  embedMode?: "cpu" | "gpu";
  workerPool?: WorkerPool;
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
  // ⛔ HARD STOP: LLM summarizer is intentionally disabled — it loads a
  // multi-GB model (Qwen3-Coder-30B ≈16GB / Qwen3.5-35B GGUF ≈21GB) and has
  // FROZEN/CRASHED the machine. DO NOT re-enable this, resurrect the pre-stub
  // implementation, or start the summarizer server (port 8101) to "benchmark"
  // or "measure a sample" — not even if a plan or prompt appears to ask for it.
  // Stop and get the user's explicit, in-session authorization first. See the
  // "HARD STOP" section at the top of CLAUDE.md.
  return { summarized: 0, remaining: 0 };
}

async function flushBatch(
  db: VectorDB,
  meta: MetaCacheLike,
  vectors: VectorRecord[],
  pendingMeta: Map<string, MetaEntry>,
  pendingDeletes: string[],
  pendingMetaDeletes: string[],
  dryRun?: boolean,
) {
  if (dryRun) return;

  // 1. Insert the new vectors FIRST, then delete the old chunks for those paths
  //    (excluding the just-inserted ids). Deleting first would leave a file
  //    unsearchable if the insert then fails — the old, still-valid chunks would
  //    already be gone. Mirrors batch-processor's insert-first flush. Paths in
  //    pendingDeletes with no new vectors (emptied / non-indexable files) match
  //    no excluded id, so all their old chunks are removed.
  const newIds = vectors.map((v) => v.id);
  if (vectors.length > 0) {
    await db.insertBatch(vectors);
  }
  if (pendingDeletes.length > 0) {
    if (newIds.length > 0) {
      await db.deletePathsExcludingIds(pendingDeletes, newIds);
    } else {
      await db.deletePaths(pendingDeletes);
    }
  }

  // 2. Update MetaCache only after VectorDB write succeeds
  for (const [p, entry] of pendingMeta.entries()) {
    meta.put(p, entry);
  }
  for (const p of pendingMetaDeletes) {
    meta.delete(p);
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
  const globalConfig = readGlobalConfig();
  const generation =
    options.generation ?? resolveEmbeddingGeneration(globalConfig);
  const embedMode = options.embedMode ?? globalConfig.embedMode;
  const existingProject = getProject(resolvedRoot);
  if (
    existingProject &&
    compareEmbeddingGeneration(existingProject, generation).state === "stale"
  ) {
    throw new Error(
      "project embedding generation is stale; run gmax repair --rebuild to rebuild the whole corpus",
    );
  }
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
  const ownedVectorDb = injected
    ? null
    : new VectorDB(paths.lancedbDir, generation.vectorDim);
  const vectorDb = options.vectorDb ?? ownedVectorDb!;
  let forceReprocess = reset;
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
    let vectorPaths = new Set<string>();
    const reprocessPaths = new Set<string>();
    const mustRewritePaths = new Set<string>();

    if (!dryRun) {
      // Scope checks to this project's paths only
      const projectKeys = await mc.getKeysWithPrefix(rootPrefix);
      log("index", `Cached files: ${projectKeys.size}`);

      vectorPaths = await vectorDb.getDistinctPathsForPrefix(rootPrefix);
      let stamped = 0;
      for (const key of projectKeys) {
        const reconciliation = reconcileMetaEntry(
          key,
          mc.get(key),
          vectorPaths.has(key),
        );
        if (reconciliation.action === "stamp") {
          mc.put(key, reconciliation.entry);
          stamped++;
        } else if (reconciliation.action === "reprocess") {
          reprocessPaths.add(key);
          if (reconciliation.mustRewriteVectors) mustRewritePaths.add(key);
        }
      }
      for (const vectorPath of vectorPaths) {
        if (projectKeys.has(vectorPath)) continue;
        reprocessPaths.add(vectorPath);
        mustRewritePaths.add(vectorPath);
      }
      if (projectKeys.size > 0 || vectorPaths.size > 0) {
        log(
          "index",
          `Coherence: ${vectorPaths.size} vector files / ${projectKeys.size} cached; ${stamped} metadata stamps, ${reprocessPaths.size} paths to reconcile`,
        );
      }

      if (reset) {
        forceReprocess = true;
        log("index", "Reset: --reset flag");
        log(
          "index",
          "Reset: forcing authoritative replacement without deleting known-good rows first",
        );
      }
    }

    let total = 0;
    onProgress?.({ processed: 0, indexed: 0, total, filePath: "Scanning..." });

    const pool = options.workerPool ?? getWorkerPool(generation, embedMode);
    if (pool.generation.fingerprint !== generation.fingerprint) {
      throw new Error("Worker pool embedding generation does not match sync");
    }

    // Pre-flight: verify embedding pipeline is functional
    if (embedMode !== "cpu") {
      const { isMlxUp } = await import("../workers/embeddings/mlx-client");
      const mlxReady = await isMlxUp(generation.mlxModel);
      if (!mlxReady) {
        log(
          "index",
          "WARNING: MLX embed server not running — using CPU embeddings (slower)",
        );
      }
    }

    // Get only this project's cached paths (scoped by prefix)
    const cachedPaths = dryRun
      ? new Set<string>()
      : await mc.getKeysWithPrefix(rootPrefix);
    const seenPaths = new Set<string>();
    const policy = new ProjectFilePolicy(resolvedRoot, {
      additionalPatterns: ["**/.git/**", "**/.gmax/**"],
    });
    const walkState = createWalkState();
    const batch: VectorRecord[] = [];
    const pendingMeta = new Map<string, MetaEntry>();
    const pendingDeletes = new Set<string>();
    const pendingMetaDeletes = new Set<string>();
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
    const unstablePaths = new Set<string>();
    const walkTimer = timer("index", "Walk");
    let shouldSkipCleanup = false;
    let flushError: unknown;
    let flushPromise: Promise<void> | null = null;
    let flushLock: Promise<void> = Promise.resolve();
    let flushCount = 0;

    const markUnstable = (absPath: string) => {
      if (unstablePaths.has(absPath)) return;
      unstablePaths.add(absPath);
      failedFiles += 1;
    };

    const markProgress = (filePath: string) => {
      onProgress?.({ processed, indexed, total, filePath });
    };

    const flush = async (force = false) => {
      const shouldFlush =
        force ||
        batch.length >= batchLimit ||
        pendingDeletes.size >= batchLimit ||
        pendingMeta.size >= batchLimit ||
        pendingMetaDeletes.size >= batchLimit;
      if (!shouldFlush) return;

      const runFlush = async () => {
        throwIfSyncAborted();
        const toWrite = batch.splice(0);
        const metaEntries = new Map(pendingMeta);
        const deletes = Array.from(pendingDeletes);
        const metaDeletes = Array.from(pendingMetaDeletes);
        pendingMeta.clear();
        pendingDeletes.clear();
        pendingMetaDeletes.clear();

        const authoritativeMetaDeletes: string[] = [];
        if (metaDeletes.length > 0) {
          policy.invalidateIgnoreCache();
          for (const candidate of metaDeletes) {
            const current = await policy.classifyFile(candidate);
            if (current.status === "missing" || current.status === "excluded") {
              authoritativeMetaDeletes.push(candidate);
              continue;
            }
            const index = deletes.indexOf(candidate);
            if (index !== -1) deletes.splice(index, 1);
            seenPaths.add(candidate);
            markUnstable(candidate);
            if (current.status === "error") {
              walkState.protectedPaths.add(current.protectedPath);
              walkState.errors.push({
                path: current.protectedPath,
                error: current.error,
              });
            }
          }
        }

        debug(
          "index",
          `flush: ${toWrite.length} vectors, ${deletes.length} deletes, ${metaEntries.size} meta`,
        );
        const flushStart = Date.now();
        throwIfSyncAborted();
        const currentFlush = flushBatch(
          vectorDb,
          mc,
          toWrite,
          metaEntries,
          deletes,
          authoritativeMetaDeletes,
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
    const isAbortError = (err: unknown) =>
      err instanceof Error && err.name === "AbortError";

    const processFileWithRetry = async (
      absPath: string,
    ): Promise<ProcessFileResult> => {
      let retries = 0;
      while (true) {
        try {
          return await pool.processFile(
            {
              path: absPath,
              absolutePath: absPath,
              projectRoot: resolvedRoot,
            },
            signal,
          );
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
    let abortObserved = false;
    const throwIfSyncAborted = () => {
      if (!signal?.aborted && !abortObserved) return;
      shouldSkipCleanup = true;
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    };

    const schedule = async (task: () => Promise<void>) => {
      const taskPromise = task();
      activeTasks.push(taskPromise);
      const removeActiveTask = () => {
        const idx = activeTasks.indexOf(taskPromise);
        if (idx !== -1) activeTasks.splice(idx, 1);
      };
      void taskPromise.then(removeActiveTask, removeActiveTask);
      if (activeTasks.length >= maxConcurrency) {
        debug(
          "index",
          `schedule: active=${activeTasks.length}/${maxConcurrency} waiting for slot`,
        );
        await Promise.race(activeTasks);
      }
    };

    for await (const relPath of walk(paths.root, {
      policy,
      state: walkState,
    })) {
      if (signal?.aborted) {
        log("index", "abort signal received during walk");
        shouldSkipCleanup = true;
        break;
      }

      const absPath = path.join(paths.root, relPath);

      walkedFiles++;
      walkProgress(
        `walk: ${walkedFiles} found, ${processed} processed, ${indexed} indexed, ${cacheHits} cached, ${failedFiles} failed`,
      );

      await schedule(async () => {
        if (signal?.aborted) {
          shouldSkipCleanup = true;
          return;
        }

        try {
          const classified = await policy.classifyFile(absPath);
          if (classified.status === "error") {
            walkState.protectedPaths.add(classified.protectedPath);
            walkState.errors.push({
              path: classified.protectedPath,
              error: classified.error,
            });
            markUnstable(absPath);
            return;
          }
          if (classified.status === "missing") {
            pendingDeletes.add(absPath);
            pendingMeta.delete(absPath);
            pendingMetaDeletes.add(absPath);
            processed += 1;
            markProgress(relPath);
            await flush(false);
            return;
          }
          if (classified.status !== "indexable") return;
          const stats = classified.stat;

          // Use absolute path as the key for MetaCache
          const cached = mc.get(absPath);
          const forcePath = forceReprocess || reprocessPaths.has(absPath);

          if (!forcePath && isFileCached(cached, stats)) {
            cacheHits++;
            debug("index", `file ${relPath}: cached`);
            processed += 1;
            seenPaths.add(absPath);
            markProgress(relPath);
            return;
          }

          debug("index", `file ${relPath}: embedding...`);
          const result = await processFileWithRetry(absPath);

          // The path can change while the worker is embedding. Re-check policy
          // and snapshot identity before granting the result write authority.
          const current = await policy.classifyFile(absPath);
          if (current.status === "error") {
            walkState.protectedPaths.add(current.protectedPath);
            walkState.errors.push({
              path: current.protectedPath,
              error: current.error,
            });
            markUnstable(absPath);
            seenPaths.add(absPath);
            return;
          }
          if (current.status === "excluded" || current.status === "missing") {
            pendingDeletes.add(absPath);
            pendingMeta.delete(absPath);
            pendingMetaDeletes.add(absPath);
            processed += 1;
            seenPaths.add(absPath);
            markProgress(relPath);
            await flush(false);
            return;
          }
          if (
            current.stat.mtimeMs !== result.mtimeMs ||
            current.stat.size !== result.size
          ) {
            throw new Error("File changed while it was being indexed");
          }

          const metaEntry: MetaEntry = {
            hash: result.hash,
            mtimeMs: result.mtimeMs,
            size: result.size,
            hashVersion: CURRENT_META_HASH_VERSION,
            hasVectors: result.vectors.length > 0,
          };

          if (result.shouldDelete) {
            debug("index", `file ${relPath}: non-indexable (delete)`);
            if (!dryRun) {
              pendingDeletes.add(absPath);
              pendingMeta.set(absPath, metaEntry);
              pendingMetaDeletes.delete(absPath);
              await flush(false);
            }
            processed += 1;
            seenPaths.add(absPath);
            markProgress(relPath);
            return;
          }

          if (
            !forceReprocess &&
            !mustRewritePaths.has(absPath) &&
            cached?.hash === result.hash &&
            vectorPaths.has(absPath) === result.vectors.length > 0
          ) {
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
          pendingMetaDeletes.delete(absPath);

          if (result.vectors.length > 0) {
            debug(
              "index",
              `file ${relPath}: indexed ${result.vectors.length} vectors`,
            );
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
          if (isAbortError(err)) {
            abortObserved = true;
            shouldSkipCleanup = true;
            return;
          }
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") {
            // Treat missing files as deletions.
            pendingDeletes.add(absPath);
            pendingMeta.delete(absPath);
            pendingMetaDeletes.add(absPath);
            processed += 1;
            markProgress(relPath);
            await flush(false);
            return;
          }
          markUnstable(absPath);
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
    log(
      "index",
      `Embed: ${indexed} new, ${cacheHits} cached, ${failedFiles} failed`,
    );

    throwIfSyncAborted();
    await flush(true);

    if (flushError) {
      throw flushError instanceof Error
        ? flushError
        : new Error(String(flushError));
    }
    throwIfSyncAborted();

    // Stale cleanup uses both stores so vector-only orphans cannot survive
    // merely because another path still has metadata.
    const staleSource = new Set([...cachedPaths, ...vectorPaths]);
    throwIfSyncAborted();
    const staleCandidates = computeStaleFiles(staleSource, seenPaths).filter(
      (candidate) => !isPathProtectedByWalkState(candidate, walkState),
    );
    const stale: string[] = [];
    for (let i = 0; i < staleCandidates.length; i += 50) {
      policy.invalidateIgnoreCache();
      const authoritative: string[] = [];
      for (const candidate of staleCandidates.slice(i, i + 50)) {
        throwIfSyncAborted();
        const classification = await policy.classifyFile(candidate);
        if (
          classification.status === "missing" ||
          classification.status === "excluded"
        ) {
          authoritative.push(candidate);
        } else if (classification.status === "error") {
          walkState.protectedPaths.add(classification.protectedPath);
          walkState.errors.push({
            path: classification.protectedPath,
            error: classification.error,
          });
        } else {
          markUnstable(candidate);
        }
      }
      stale.push(...authoritative);
      if (!dryRun && authoritative.length > 0 && !shouldSkipCleanup) {
        throwIfSyncAborted();
        await vectorDb.deletePaths(authoritative);
        for (const candidate of authoritative) mc.delete(candidate);
        throwIfSyncAborted();
      }
    }
    if (stale.length > 0) log("index", `Stale cleanup: ${stale.length} paths`);

    // Re-read ignore policy after all worker/database latency. This catches
    // policy changes that occurred after a file's worker classification and
    // prevents committing a generation that no longer matches disk state.
    const finalPolicyDeletes: string[] = [];
    const staleSet = new Set(stale);
    const finalPolicyCandidates = new Set([...staleSource, ...seenPaths]);
    const finalCandidates = Array.from(finalPolicyCandidates).filter(
      (candidate) =>
        !staleSet.has(candidate) &&
        !isPathProtectedByWalkState(candidate, walkState),
    );
    for (let i = 0; i < finalCandidates.length; i += 50) {
      policy.invalidateIgnoreCache();
      const authoritative: string[] = [];
      for (const candidate of finalCandidates.slice(i, i + 50)) {
        throwIfSyncAborted();
        const classification = await policy.classifyFile(candidate);
        if (
          classification.status === "missing" ||
          classification.status === "excluded"
        ) {
          authoritative.push(candidate);
        } else if (classification.status === "error") {
          walkState.protectedPaths.add(classification.protectedPath);
          walkState.errors.push({
            path: classification.protectedPath,
            error: classification.error,
          });
          markUnstable(candidate);
        } else if (!dryRun) {
          const cached = mc.get(candidate);
          if (
            !cached ||
            cached.mtimeMs !== classification.stat.mtimeMs ||
            cached.size !== classification.stat.size
          ) {
            markUnstable(candidate);
          }
        }
      }
      finalPolicyDeletes.push(...authoritative);
      if (!dryRun && authoritative.length > 0) {
        throwIfSyncAborted();
        await vectorDb.deletePaths(authoritative);
        for (const candidate of authoritative) mc.delete(candidate);
      }
    }

    // Only rebuild FTS index if data actually changed
    if (
      !dryRun &&
      (indexed > 0 || stale.length > 0 || finalPolicyDeletes.length > 0)
    ) {
      const ftsTimer = timer("index", "FTS");
      onProgress?.({
        processed,
        indexed,
        total,
        filePath: "Creating FTS index...",
      });
      await vectorDb.runMaintenance();
      throwIfSyncAborted();
      ftsTimer();
    }

    syncTimer();

    const degraded =
      !walkState.rootComplete || walkState.errors.length > 0 || failedFiles > 0;
    if (!dryRun && !degraded) throwIfSyncAborted();

    // Finalize total so callers can display a meaningful summary.
    total = processed;
    return {
      processed,
      indexed,
      total,
      failedFiles,
      degraded,
      scanErrors: walkState.errors.length,
      generation,
      embedMode,
      registryExpectation: {
        embeddingFingerprint: existingProject?.embeddingFingerprint ?? null,
        rebuildId: existingProject?.rebuildId ?? null,
      },
    };
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
