import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { CONFIG } from "../../config";
import { ensureProjectPaths } from "../utils/project-root";
import { DEFAULT_IGNORE_PATTERNS } from "./ignore-patterns";
import {
  type InitialSyncProgress,
  type InitialSyncResult,
} from "./sync-helpers";
import { computeBufferHash, isIndexableFile } from "../utils/file-utils";
import { MetaCache, type MetaEntry } from "../store/meta-cache";
import { VectorDB } from "../store/vector-db";
import { workerPool } from "../workers/pool";
import type { VectorRecord } from "../store/types";

type SyncOptions = {
  projectRoot: string;
  dryRun?: boolean;
  onProgress?: (info: InitialSyncProgress) => void;
  signal?: AbortSignal;
};

type GlobOptions = fg.Options;

function buildIgnoreFilter(projectRoot: string) {
  const filter = ignore();
  const osgrepIgnore = path.join(projectRoot, ".osgrepignore");
  if (fs.existsSync(osgrepIgnore)) {
    filter.add(fs.readFileSync(osgrepIgnore, "utf-8"));
  }
  return filter;
}

async function countFiles(
  globOptions: GlobOptions,
  filter: ReturnType<typeof buildIgnoreFilter>,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0;
  for await (const entry of fg.stream("**/*", globOptions)) {
    if (signal?.aborted) break;
    const relPath = entry.toString();
    if (filter.ignores(relPath)) continue;
    const cwd = globOptions.cwd ?? process.cwd();
    const absPath = path.join(cwd, relPath);
    if (isIndexableFile(absPath)) {
      total += 1;
    }
  }
  return total;
}

async function flushBatch(
  db: VectorDB,
  meta: MetaCache,
  batch: VectorRecord[],
  pendingMeta: Map<string, MetaEntry>,
  dryRun?: boolean,
) {
  if (batch.length === 0) return;
  const toWrite = batch.splice(0);
  const metaEntries = Array.from(pendingMeta.entries());
  pendingMeta.clear();

  if (dryRun) return;
  await db.insertBatch(toWrite);
  for (const [p, entry] of metaEntries) {
    meta.put(p, entry);
  }
}

export async function initialSync(options: SyncOptions): Promise<InitialSyncResult> {
  const {
    projectRoot,
    dryRun = false,
    onProgress,
    signal,
  } = options;
  const paths = ensureProjectPaths(projectRoot);
  const vectorDb = new VectorDB(paths.lancedbDir);
  const metaCache = new MetaCache(paths.lmdbPath);
  const ignoreFilter = buildIgnoreFilter(paths.root);

  const globOptions: GlobOptions = {
    cwd: paths.root,
    dot: false,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
    ignore: [...DEFAULT_IGNORE_PATTERNS, ".git/**", ".osgrep/**"],
    suppressErrors: true,
  };

  const total = await countFiles(globOptions, ignoreFilter, signal);
  onProgress?.({ processed: 0, indexed: 0, total, filePath: "Scanning..." });

  const storedPaths = await vectorDb.listPaths();
  const seenPaths = new Set<string>();
  const batch: any[] = [];
  const pendingMeta = new Map<string, MetaEntry>();
  const batchLimit = Math.max(1, CONFIG.EMBED_BATCH_SIZE);

  let processed = 0;
  let indexed = 0;

  for await (const entry of fg.stream("**/*", globOptions)) {
    if (signal?.aborted) break;
    const relPath = entry.toString();
    if (ignoreFilter.ignores(relPath)) continue;

    const absPath = path.join(paths.root, relPath);
    if (!isIndexableFile(absPath)) continue;

    try {
      const stats = await fs.promises.stat(absPath);
      const cached = metaCache.get(relPath);

      if (
        cached &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.size === stats.size
      ) {
        processed += 1;
        seenPaths.add(relPath);
        onProgress?.({ processed, indexed, total, filePath: relPath });
        continue;
      }

      const buffer = await fs.promises.readFile(absPath);
      if (buffer.length === 0) {
        processed += 1;
        seenPaths.add(relPath);
        onProgress?.({ processed, indexed, total, filePath: relPath });
        continue;
      }
      const hash = computeBufferHash(buffer);

      if (cached && cached.hash === hash) {
        metaCache.put(relPath, {
          hash,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        });
        processed += 1;
        seenPaths.add(relPath);
        onProgress?.({ processed, indexed, total, filePath: relPath });
        continue;
      }

      if (dryRun) {
        processed += 1;
        indexed += 1;
        seenPaths.add(relPath);
        onProgress?.({ processed, indexed, total, filePath: relPath });
        continue;
      }

      const vectors = await workerPool.processFile({
        path: relPath,
        content: buffer.toString("utf-8"),
        hash,
      });

      if (vectors.length > 0) {
        batch.push(...vectors);
        pendingMeta.set(relPath, {
          hash,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        });
        indexed += 1;
      }

      seenPaths.add(relPath);
      processed += 1;
      onProgress?.({ processed, indexed, total, filePath: relPath });

      if (batch.length >= batchLimit) {
        await flushBatch(vectorDb, metaCache, batch, pendingMeta, dryRun);
      }
    } catch (err) {
      processed += 1;
      console.error(`[sync] Failed to process ${relPath}:`, err);
      onProgress?.({ processed, indexed, total, filePath: relPath });
    }
  }

  await flushBatch(vectorDb, metaCache, batch, pendingMeta, dryRun);

  const stale = Array.from(storedPaths.keys()).filter((p) => !seenPaths.has(p));
  if (!dryRun && stale.length > 0) {
    await vectorDb.deletePaths(stale);
    stale.forEach((p) => metaCache.delete(p));
  }

  return { processed, indexed, total };
}
