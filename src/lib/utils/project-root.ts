import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";

export interface ProjectPaths {
  /** The directory being indexed/searched (walk root) */
  root: string;
  /** Centralized data directory (~/.gmax) */
  dataDir: string;
  /** Centralized LanceDB directory (~/.gmax/lancedb) */
  lancedbDir: string;
  /** Centralized cache directory (~/.gmax/cache) */
  cacheDir: string;
  /** Centralized LMDB metadata path (~/.gmax/cache/meta.lmdb) */
  lmdbPath: string;
  /** Centralized config path (~/.gmax/config.json) */
  configPath: string;
}

/**
 * Find the project root for a given directory.
 * Looks for .git to determine the project boundary.
 * Falls back to the directory itself if no .git found.
 */
export function findProjectRoot(startDir = process.cwd()): string {
  const start = path.resolve(startDir);

  // Walk up to find .git
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // No .git found — treat startDir as root
  return start;
}

/**
 * Returns centralized paths for storage.
 * The `root` field is the directory being indexed/searched.
 * All storage paths point to ~/.gmax/ (centralized).
 */
export function ensureProjectPaths(
  startDir = process.cwd(),
  options?: { dryRun?: boolean },
): ProjectPaths {
  const root = findProjectRoot(startDir);

  if (!options?.dryRun) {
    // Ensure centralized directories exist
    for (const dir of [PATHS.lancedbDir, PATHS.cacheDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return {
    root,
    dataDir: PATHS.globalRoot,
    lancedbDir: PATHS.lancedbDir,
    cacheDir: PATHS.cacheDir,
    lmdbPath: PATHS.lmdbPath,
    configPath: PATHS.configPath,
  };
}
