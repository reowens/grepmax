/**
 * Centralized watcher launch logic.
 * Single function that all code paths use to spawn a watcher.
 */

import { spawn } from "node:child_process";
import { getProject } from "./project-registry";
import {
  getWatcherCoveringPath,
  getWatcherForProject,
  isProcessRunning,
} from "./watcher-store";

export type LaunchResult =
  | { ok: true; pid: number; reused: boolean }
  | { ok: false; reason: "not-registered" | "spawn-failed"; message: string };

export function launchWatcher(projectRoot: string): LaunchResult {
  // 1. Project must be registered
  const project = getProject(projectRoot);
  if (!project) {
    return {
      ok: false,
      reason: "not-registered",
      message: `Project not registered. Run: gmax add ${projectRoot}`,
    };
  }

  // 2. Check if watcher already running
  const existing =
    getWatcherForProject(projectRoot) ??
    getWatcherCoveringPath(projectRoot);
  if (existing && isProcessRunning(existing.pid)) {
    return { ok: true, pid: existing.pid, reused: true };
  }

  // 3. Spawn
  try {
    const child = spawn(
      process.argv[0],
      [process.argv[1], "watch", "--path", projectRoot, "-b"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();

    if (child.pid) {
      return { ok: true, pid: child.pid, reused: false };
    }
    return {
      ok: false,
      reason: "spawn-failed",
      message: `Spawn returned no PID for ${projectRoot}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "spawn-failed",
      message: `Failed to start watcher for ${projectRoot}: ${msg}`,
    };
  }
}
