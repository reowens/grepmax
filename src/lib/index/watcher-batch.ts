import * as fs from "node:fs";
import type { MetaEntry } from "../store/meta-cache";
import type { VectorRecord } from "../store/types";
import { isFileCached } from "../utils/cache-check";
import { isIndexableFile } from "../utils/file-utils";

export interface MetaCacheLike {
  get(filePath: string): MetaEntry | undefined;
}

export interface WorkerPoolLike {
  processFile(
    input: {
      path: string;
      absolutePath: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    vectors: VectorRecord[];
    hash: string;
    mtimeMs: number;
    size: number;
    shouldDelete?: boolean;
  }>;
}

export interface VectorDbLike {
  insertBatch(vectors: VectorRecord[]): Promise<void>;
  deletePathsExcludingIds(paths: string[], excludeIds: string[]): Promise<void>;
  deletePaths(paths: string[]): Promise<void>;
}

export interface BatchResult {
  reindexed: number;
  changedIds: string[];
  vectors: VectorRecord[];
  deletes: string[];
  metaUpdates: Map<string, MetaEntry>;
  metaDeletes: string[];
}

export async function processBatchCore(
  batch: Map<string, "change" | "unlink">,
  metaCache: MetaCacheLike,
  pool: WorkerPoolLike,
  signal?: AbortSignal,
): Promise<BatchResult> {
  let reindexed = 0;
  const changedIds: string[] = [];
  const deletes: string[] = [];
  const vectors: VectorRecord[] = [];
  const metaUpdates = new Map<string, MetaEntry>();
  const metaDeletes: string[] = [];

  for (const [absPath, event] of batch) {
    if (signal?.aborted) break;
    if (event === "unlink") {
      deletes.push(absPath);
      metaDeletes.push(absPath);
      reindexed++;
      continue;
    }

    try {
      const stats = await fs.promises.stat(absPath);
      if (!isIndexableFile(absPath, stats.size)) continue;

      const cached = metaCache.get(absPath);
      if (isFileCached(cached, stats)) {
        continue;
      }

      const result = await pool.processFile({
        path: absPath,
        absolutePath: absPath,
      }, signal);

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
        for (const v of result.vectors) {
          changedIds.push(v.id);
        }
      }
      metaUpdates.set(absPath, metaEntry);
      reindexed++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        deletes.push(absPath);
        metaDeletes.push(absPath);
        reindexed++;
      }
    }
  }

  return { reindexed, changedIds, vectors, deletes, metaUpdates, metaDeletes };
}

export async function flushBatchToDb(
  result: BatchResult,
  vectorDb: VectorDbLike,
): Promise<void> {
  const newIds = result.vectors.map((v) => v.id);
  if (result.vectors.length > 0) {
    await vectorDb.insertBatch(result.vectors);
  }
  if (result.deletes.length > 0) {
    if (newIds.length > 0) {
      await vectorDb.deletePathsExcludingIds(result.deletes, newIds);
    } else {
      await vectorDb.deletePaths(result.deletes);
    }
  }
}

export function computeRetryAction(
  batch: Map<string, "change" | "unlink">,
  retryCount: Map<string, number>,
  maxRetries: number,
  isLockError: boolean,
  consecutiveLockFailures: number,
  debounceMs: number,
): {
  requeued: Map<string, "change" | "unlink">;
  dropped: number;
  backoffMs: number;
} {
  const requeued = new Map<string, "change" | "unlink">();
  let dropped = 0;

  for (const [absPath, event] of batch) {
    const count = (retryCount.get(absPath) ?? 0) + 1;
    if (count >= maxRetries) {
      retryCount.delete(absPath);
      dropped++;
    } else {
      requeued.set(absPath, event);
      retryCount.set(absPath, count);
    }
  }

  const effectiveFailures = isLockError ? consecutiveLockFailures + 1 : 0;
  const backoffMs = Math.min(
    debounceMs * 2 ** effectiveFailures,
    30_000,
  );

  return { requeued, dropped, backoffMs };
}
