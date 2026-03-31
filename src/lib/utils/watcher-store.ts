/**
 * LMDB-backed watcher registry — replaces the JSON-based watcher-registry.ts.
 *
 * Provides ACID transactions for watcher state, eliminating race conditions
 * when multiple processes (Claude sessions, MCP, CLI) read/write concurrently.
 *
 * Stored in ~/.gmax/cache/watchers.lmdb
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { open, type RootDatabase } from "lmdb";
import { PATHS } from "../../config";

export interface WatcherInfo {
  pid: number;
  projectRoot: string;
  startTime: number;
  status?: "syncing" | "watching" | "summarizing";
  lastReindex?: number;
  lastHeartbeat?: number;
}

const STORE_PATH = path.join(PATHS.cacheDir, "watchers.lmdb");
const HEARTBEAT_STALE_MS = 5 * 60 * 1000; // 5 minutes

let _db: RootDatabase<WatcherInfo> | null = null;

function getDb(): RootDatabase<WatcherInfo> {
  if (!_db) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    _db = open<WatcherInfo>({
      path: STORE_PATH,
      compression: true,
    });
  }
  return _db;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlive(info: WatcherInfo): boolean {
  if (!isProcessRunning(info.pid)) return false;
  // If heartbeat exists and is stale, treat as dead (possibly deadlocked)
  if (info.lastHeartbeat && Date.now() - info.lastHeartbeat > HEARTBEAT_STALE_MS) {
    return false;
  }
  return true;
}

export function registerWatcher(info: WatcherInfo): void {
  const db = getDb();
  // Prune any existing dead entry for this project
  const existing = db.get(info.projectRoot);
  if (existing && !isAlive(existing)) {
    db.remove(info.projectRoot);
  }
  db.put(info.projectRoot, { ...info, lastHeartbeat: Date.now() });
}

export function updateWatcherStatus(
  pid: number,
  status: WatcherInfo["status"],
  lastReindex?: number,
): void {
  const db = getDb();
  // Find entry by PID (iterate since key is projectRoot)
  for (const { key, value } of db.getRange()) {
    if (value && value.pid === pid) {
      db.put(String(key), {
        ...value,
        status,
        lastHeartbeat: Date.now(),
        ...(lastReindex ? { lastReindex } : {}),
      });
      return;
    }
  }
}

export function heartbeat(pid: number): void {
  const db = getDb();
  for (const { key, value } of db.getRange()) {
    if (value && value.pid === pid) {
      db.put(String(key), { ...value, lastHeartbeat: Date.now() });
      return;
    }
  }
}

export function unregisterWatcher(pid: number): void {
  const db = getDb();
  for (const { key, value } of db.getRange()) {
    if (value && value.pid === pid) {
      db.remove(String(key));
      return;
    }
  }
}

export function getWatcherForProject(
  projectRoot: string,
): WatcherInfo | undefined {
  const db = getDb();
  const info = db.get(projectRoot);
  if (!info) return undefined;
  if (isAlive(info)) return info;
  // Clean stale entry
  db.remove(projectRoot);
  return undefined;
}

export function getWatcherCoveringPath(
  dir: string,
): WatcherInfo | undefined {
  const resolved = dir.endsWith("/") ? dir : `${dir}/`;
  const db = getDb();
  for (const { key, value } of db.getRange()) {
    if (!value) continue;
    const root = String(key);
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (resolved.startsWith(prefix) && isAlive(value)) {
      return value;
    }
  }
  return undefined;
}

export function listWatchers(): WatcherInfo[] {
  const db = getDb();
  const alive: WatcherInfo[] = [];
  const dead: string[] = [];

  for (const { key, value } of db.getRange()) {
    if (!value) continue;
    if (isAlive(value)) {
      alive.push(value);
    } else {
      dead.push(String(key));
    }
  }

  // Prune dead entries
  for (const key of dead) {
    db.remove(key);
  }

  return alive;
}

/**
 * Migrate from legacy watchers.json if it exists.
 * Call once on startup.
 */
export function migrateFromJson(): void {
  const jsonPath = path.join(PATHS.globalRoot, "watchers.json");
  if (!fs.existsSync(jsonPath)) return;

  try {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const entries = JSON.parse(raw) as WatcherInfo[];
    const db = getDb();

    for (const entry of entries) {
      if (entry.projectRoot && isProcessRunning(entry.pid)) {
        db.put(entry.projectRoot, { ...entry, lastHeartbeat: Date.now() });
      }
    }

    // Remove legacy file
    fs.unlinkSync(jsonPath);
  } catch {
    // Best effort — ignore
  }
}

export { isProcessRunning };
