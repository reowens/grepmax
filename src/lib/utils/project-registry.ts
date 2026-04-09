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
  const tmp = REGISTRY_PATH + ".tmp";
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
    release = lockfile.lockSync(REGISTRY_PATH, { stale: 10_000, retries: { retries: 3, minTimeout: 100 } });
    return fn();
  } finally {
    try { release?.(); } catch {}
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
    (e) => e.root !== root && resolved.startsWith(e.root.endsWith("/") ? e.root : `${e.root}/`),
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
