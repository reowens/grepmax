/**
 * Global project registry — tracks all indexed projects for
 * cross-project search and dimension compatibility checking.
 *
 * Stored in ~/.gmax/projects.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { PATHS } from "../../config";

export interface ProjectEntry {
  root: string;
  name: string;
  vectorDim: number;
  modelTier: string;
  embedMode: string;
  lastIndexed: string;
  chunkCount?: number;
  status?: "pending" | "indexed" | "error";
  /** CONFIG.CHUNKER_VERSION at the time of the last full index. Stamped only
   * by full-sync completion paths (not incremental batches) — a mismatch with
   * the current constant means the index needs `gmax index` to pick up
   * chunk-metadata fixes. */
  chunkerVersion?: number;
}

const REGISTRY_PATH = path.join(PATHS.globalRoot, "projects.json");

function loadRegistry(): ProjectEntry[] {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
    return JSON.parse(raw) as ProjectEntry[];
  } catch {
    return [];
  }
}

function saveRegistry(entries: ProjectEntry[]): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  const tmp = `${REGISTRY_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  fs.renameSync(tmp, REGISTRY_PATH);
}

function withRegistryLock<T>(fn: () => T): T {
  // Ensure the directory exists for the lock target
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  // Ensure the file exists (lockSync needs it)
  if (!fs.existsSync(REGISTRY_PATH)) {
    fs.writeFileSync(REGISTRY_PATH, "[]\n");
  }
  let release: (() => void) | undefined;
  try {
    release = lockfile.lockSync(REGISTRY_PATH, { stale: 10_000 });
    return fn();
  } finally {
    try {
      release?.();
    } catch {}
  }
}

export function registerProject(entry: ProjectEntry): void {
  withRegistryLock(() => {
    const entries = loadRegistry();
    const idx = entries.findIndex((e) => e.root === entry.root);
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }
    saveRegistry(entries);
  });
}

export function listProjects(): ProjectEntry[] {
  return loadRegistry();
}

export function getProject(root: string): ProjectEntry | undefined {
  return loadRegistry().find((e) => e.root === root);
}

export function removeProject(root: string): void {
  withRegistryLock(() => {
    const entries = loadRegistry().filter((e) => e.root !== root);
    saveRegistry(entries);
  });
}

/**
 * Find a registered parent that covers this path, if any.
 */
export function getParentProject(root: string): ProjectEntry | undefined {
  const resolved = root.endsWith("/") ? root : `${root}/`;
  return loadRegistry().find(
    (e) =>
      e.root !== root &&
      resolved.startsWith(e.root.endsWith("/") ? e.root : `${e.root}/`),
  );
}

/**
 * Find registered projects that are children of this path.
 */
export function getChildProjects(root: string): ProjectEntry[] {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return loadRegistry().filter(
    (e) => e.root !== root && e.root.startsWith(prefix),
  );
}

/**
 * Resolve a `--root` argument with cwd fallback, printing the helper's
 * error message and setting process.exitCode = 1 on failure. Returns
 * null when the caller should bail out. Used at command entry points.
 */
export function resolveRootOrExit(arg: string | undefined): string | null {
  if (!arg) return process.cwd();
  try {
    return resolveProjectRoot(arg);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return null;
  }
}

/**
 * Resolve a `--root` argument that may be either a path or a registered
 * project name. Throws on no-match or duplicate-name so callers can
 * report a uniform error.
 */
export function resolveProjectRoot(arg: string): string {
  if (arg.includes("/") || arg.includes("\\")) return path.resolve(arg);
  const resolved = path.resolve(arg);
  if (fs.existsSync(resolved)) return resolved;

  const matches = loadRegistry().filter((p) => p.name === arg);
  if (matches.length === 1) return matches[0].root;
  if (matches.length === 0) {
    const all = loadRegistry();
    const list =
      all.length > 0
        ? all.map((p) => `  ${p.name.padEnd(24)} ${p.root}`).join("\n")
        : "  (none registered)";
    throw new Error(
      `No registered project named "${arg}".\nAvailable:\n${list}`,
    );
  }
  const paths = matches.map((p) => `  ${p.root}`).join("\n");
  throw new Error(
    `Multiple registered projects named "${arg}":\n${paths}\nPass an absolute path to disambiguate.`,
  );
}
