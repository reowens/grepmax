import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import { isPathWithin } from "./path-containment";
import { listProjects } from "./project-registry";

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
 * Walk up from a directory to the nearest ancestor containing .git.
 * Returns null when no .git exists anywhere up the tree.
 */
export function findGitRoot(startDir = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/**
 * Find the project root for a given directory.
 *
 * The nearest .git is only a candidate boundary: a registered project may be
 * an umbrella directory with no .git of its own whose children are separate
 * git repos (so the .git walk lands on an unregistered subrepo), or the
 * nearest .git may sit above the registered root (e.g. a git-tracked home
 * dir). Resolution order:
 *   1. the nearest .git root, when it is itself a registered project
 *   2. the deepest registered project containing startDir
 *   3. the nearest .git root, else startDir (unregistered fallback)
 */
export function findProjectRoot(startDir = process.cwd()): string {
  const start = path.resolve(startDir);
  const gitRoot = findGitRoot(start);

  let registered: ReturnType<typeof listProjects> = [];
  try {
    registered = listProjects();
  } catch {
    // A corrupt registry shouldn't break root detection; commands that need
    // the registry surface the read error themselves.
  }
  const roots = registered.map((p) => path.resolve(p.root));
  if (gitRoot && roots.includes(gitRoot)) return gitRoot;
  const ancestor = roots
    .filter((root) => isPathWithin(root, start))
    .sort((a, b) => b.length - a.length)[0];
  if (ancestor) return ancestor;

  return gitRoot ?? start;
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
