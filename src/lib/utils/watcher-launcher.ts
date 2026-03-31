/**
 * Centralized watcher launch logic.
 * Single function that all code paths use to spawn a watcher.
 * Tries daemon IPC first, falls back to per-project spawn.
 */

import { spawn } from "node:child_process";
import { sendDaemonCommand } from "./daemon-client";
import { spawnDaemon } from "./daemon-launcher";
import { getProject } from "./project-registry";
import {
  getWatcherCoveringPath,
  getWatcherForProject,
  isProcessRunning,
} from "./watcher-store";

export type LaunchResult =
  | { ok: true; pid: number; reused: boolean }
  | { ok: false; reason: "not-registered" | "spawn-failed"; message: string };

export async function launchWatcher(projectRoot: string): Promise<LaunchResult> {
  // 1. Project must be registered
  const project = getProject(projectRoot);
  if (!project) {
    return {
      ok: false,
      reason: "not-registered",
      message: `Project not registered. Run: gmax add ${projectRoot}`,
    };
  }

  // 2. Check if watcher already running (daemon registers per-project entries)
  const existing =
    getWatcherForProject(projectRoot) ??
    getWatcherCoveringPath(projectRoot);
  if (existing && isProcessRunning(existing.pid)) {
    return { ok: true, pid: existing.pid, reused: true };
  }

  // 3. Try daemon IPC
  let resp: Awaited<ReturnType<typeof sendDaemonCommand>>;
  try {
    resp = await sendDaemonCommand({ cmd: "watch", root: projectRoot });
  } catch {
    resp = { ok: false, error: "request-failed" };
  }
  if (resp.ok && typeof resp.pid === "number") {
    return { ok: true, pid: resp.pid, reused: true };
  }

  // 4. Daemon not running — try to start it, poll until ready
  const error = resp.error as string | undefined;
  if (error === "ENOENT" || error === "ECONNREFUSED") {
    const daemonPid = spawnDaemon();
    if (daemonPid) {
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const retry = await sendDaemonCommand({ cmd: "watch", root: projectRoot });
          if (retry.ok && typeof retry.pid === "number") {
            return { ok: true, pid: retry.pid, reused: false };
          }
        } catch {}
      }
    }
  }

  // 5. Fall back to per-project spawn
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
