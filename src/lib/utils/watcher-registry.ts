/**
 * Watcher registry — tracks background watcher processes per project.
 * Ensures only one watcher runs per project root.
 *
 * Stored in ~/.gmax/watchers.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";

export interface WatcherInfo {
  pid: number;
  projectRoot: string;
  startTime: number;
  status?: "syncing" | "watching" | "summarizing";
  lastReindex?: number;
}

const REGISTRY_PATH = path.join(PATHS.globalRoot, "watchers.json");

function loadRegistry(): WatcherInfo[] {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
    return JSON.parse(raw) as WatcherInfo[];
  } catch {
    return [];
  }
}

function saveRegistry(entries: WatcherInfo[]): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(entries, null, 2)}\n`);
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerWatcher(info: WatcherInfo): void {
  const entries = loadRegistry().filter(
    (e) => e.projectRoot !== info.projectRoot,
  );
  entries.push(info);
  saveRegistry(entries);
}

export function updateWatcherStatus(
  pid: number,
  status: WatcherInfo["status"],
  lastReindex?: number,
): void {
  const entries = loadRegistry();
  const match = entries.find((e) => e.pid === pid);
  if (match) {
    match.status = status;
    if (lastReindex) match.lastReindex = lastReindex;
    saveRegistry(entries);
  }
}

export function unregisterWatcher(pid: number): void {
  const entries = loadRegistry().filter((e) => e.pid !== pid);
  saveRegistry(entries);
}

export function getWatcherForProject(
  projectRoot: string,
): WatcherInfo | undefined {
  const entries = loadRegistry();
  const match = entries.find((e) => e.projectRoot === projectRoot);
  if (match && isProcessRunning(match.pid)) return match;
  // Clean stale entry
  if (match) {
    saveRegistry(entries.filter((e) => e.pid !== match.pid));
  }
  return undefined;
}

export function getWatcherCoveringPath(
  dir: string,
): WatcherInfo | undefined {
  const resolved = path.resolve(dir);
  const entries = loadRegistry();
  for (const e of entries) {
    if (resolved.startsWith(e.projectRoot) && isProcessRunning(e.pid))
      return e;
  }
  return undefined;
}

export function listWatchers(): WatcherInfo[] {
  const entries = loadRegistry();
  const active = entries.filter((e) => isProcessRunning(e.pid));
  if (active.length !== entries.length) {
    saveRegistry(active);
  }
  return active;
}
