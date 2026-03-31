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
} from "./watcher-registry";

/**
 * Launch a background watcher for a project.
 *
 * Returns { pid } on success, null if:
 * - Project is not registered
 * - Watcher is already running
 * - Spawn fails
 */
export function launchWatcher(
  projectRoot: string,
): { pid: number } | null {
  // 1. Project must be registered
  const project = getProject(projectRoot);
  if (!project) {
    return null;
  }

  // 2. Check if watcher already running
  const existing =
    getWatcherForProject(projectRoot) ??
    getWatcherCoveringPath(projectRoot);
  if (existing && isProcessRunning(existing.pid)) {
    return { pid: existing.pid };
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
      return { pid: child.pid };
    }
    console.error(`[watcher-launcher] Spawn returned no PID for ${projectRoot}`);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[watcher-launcher] Failed to start watcher for ${projectRoot}: ${msg}`);
    return null;
  }
}
