import * as fs from "node:fs";
import * as path from "node:path";
import { Skeletonizer } from "../lib/skeleton";
import { getStoredSkeleton } from "../lib/skeleton/retriever";
import type { VectorDB } from "../lib/store/vector-db";

// Reuse Skeletonizer instance
let globalSkeletonizer: Skeletonizer | null = null;

export async function outputSkeletons(
  results: any[],
  projectRoot: string,
  limit: number,
  db?: VectorDB | null,
  precomputed?: Record<string, string>,
): Promise<void> {
  const seenPaths = new Set<string>();
  const filesToProcess: string[] = [];

  for (const result of results) {
    const p = (result.metadata as any)?.path;
    if (typeof p === "string" && !seenPaths.has(p)) {
      seenPaths.add(p);
      filesToProcess.push(p);
      if (filesToProcess.length >= limit) break;
    }
  }

  if (filesToProcess.length === 0) {
    console.log("No skeleton matches found.");
    console.log(
      "\nTry: broaden your query, or use `gmax skeleton <path>` to view a specific file's structure.",
    );
    process.exitCode = 1;
    return;
  }

  // Reuse or init skeletonizer for fallbacks
  if (!globalSkeletonizer) {
    globalSkeletonizer = new Skeletonizer();
    // Lazy init only if we actually fallback
  }

  const skeletonOpts = { includeSummary: true };
  const skeletonResults: Array<{
    file: string;
    skeleton: string;
    tokens: number;
    error?: string;
  }> = [];

  for (const filePath of filesToProcess) {
    // Paths from search results are now absolute (centralized index)
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectRoot, filePath);

    // 0. Daemon-supplied (preferred — already-warm DB lookup, no cold open)
    const fromDaemon = precomputed?.[absPath] ?? precomputed?.[filePath];
    if (fromDaemon) {
      skeletonResults.push({
        file: filePath,
        skeleton: fromDaemon,
        tokens: Math.ceil(fromDaemon.length / 4),
      });
      continue;
    }

    // 1. Try DB cache
    if (db) {
      const cached = await getStoredSkeleton(db, absPath);
      if (cached) {
        skeletonResults.push({
          file: filePath,
          skeleton: cached,
          tokens: Math.ceil(cached.length / 4), // Rough estimate
        });
        continue;
      }
    }

    // 2. Fallback to fresh generation
    await globalSkeletonizer.init();
    if (!fs.existsSync(absPath)) {
      skeletonResults.push({
        file: filePath,
        skeleton: `// File not found: ${filePath}`,
        tokens: 0,
        error: "File not found",
      });
      continue;
    }

    const content = fs.readFileSync(absPath, "utf-8");
    const res = await globalSkeletonizer.skeletonizeFile(
      absPath,
      content,
      skeletonOpts,
    );
    skeletonResults.push({
      file: filePath,
      skeleton: res.skeleton,
      tokens: res.tokenEstimate,
      error: res.error,
    });
  }

  // Since search doesn't support --json explicitly yet, we just print text.
  // But if we ever add it, we have the structure.
  for (const res of skeletonResults) {
    console.log(res.skeleton);
    console.log(""); // Separator
  }
}
