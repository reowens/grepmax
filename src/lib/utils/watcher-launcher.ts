/**
 * Centralized watcher launch logic.
 * Single function that all code paths use to spawn a watcher.
 * Tries daemon IPC first, falls back to per-project spawn.
 */

import { spawn } from "node:child_process";
import { autostartDisabledNotice } from "./autostart";
import { sendDaemonCommand } from "./daemon-client";
import { spawnDaemon } from "./daemon-launcher";
import { getProject } from "./project-registry";
import {
  storeWriteDeniedNotice,
  warnStoreWriteDeniedOnce,
} from "./store-access";
import {
  getWatcherCoveringPath,
  getWatcherForProject,
  isProcessRunning,
} from "./watcher-store";

export type LaunchResult =
  | { ok: true; pid: number; reused: boolean }
  | {
      ok: false;
      reason:
        | "not-registered"
        | "spawn-failed"
        | "autostart-disabled"
        | "sandboxed"
        | "daemon-refused";
      message: string;
    };

/**
 * A watch lease to take or renew with the daemon — see WatchLeases. Callers
 * without one get the daemon's default short CLI lease.
 */
export interface WatchLeaseOptions {
  holder: string;
  pid?: number;
  ttlMs?: number;
}

export async function launchWatcher(
  projectRoot: string,
  lease?: WatchLeaseOptions,
): Promise<LaunchResult> {
  // 1. Project must be registered
  const project = getProject(projectRoot);
  if (!project) {
    return {
      ok: false,
      reason: "not-registered",
      message: `Project not registered. Run: gmax add ${projectRoot}`,
    };
  }

  // 2. Check if watcher already running (daemon registers per-project entries).
  // A lease holder must reach the daemon every time: the renewal is the point.
  const existing = lease
    ? undefined
    : (getWatcherForProject(projectRoot) ??
      getWatcherCoveringPath(projectRoot));
  if (existing && isProcessRunning(existing.pid)) {
    return { ok: true, pid: existing.pid, reused: true };
  }
  const watchCmd = { cmd: "watch", root: projectRoot, ...lease };

  // 3. Try daemon IPC
  let resp: Awaited<ReturnType<typeof sendDaemonCommand>>;
  try {
    resp = await sendDaemonCommand(watchCmd);
  } catch {
    resp = { ok: false, error: "request-failed" };
  }
  if (resp.ok && typeof resp.pid === "number") {
    return { ok: true, pid: resp.pid, reused: true };
  }

  // 4. Daemon not running — try to start it, poll until ready.
  // Both remaining steps spawn a background process, so stop here when the
  // autostart kill switch is on: a quarantined daemon must stay down.
  const notice = autostartDisabledNotice();
  if (notice) {
    return { ok: false, reason: "autostart-disabled", message: notice };
  }

  // A spawned daemon (or per-project watcher) inherits this process's sandbox
  // for its whole life. If ~/.gmax is read-only here it will be read-only
  // there, and the child dies on its own lock mkdir — so probe once and say so
  // instead of leaving a crash in daemon.log.
  const sandboxed = storeWriteDeniedNotice();
  if (sandboxed) {
    warnStoreWriteDeniedOnce(sandboxed);
    return { ok: false, reason: "sandboxed", message: sandboxed };
  }

  const error = resp.error as string | undefined;
  // Anything but "nothing is listening" is a live daemon that said no or was
  // slow (initializing, busy, timeout). A per-project watcher next to it would
  // be a second writer on the store, and the MCP lease renewal would spawn one
  // every few minutes — so report instead of falling through.
  if (error !== "ENOENT" && error !== "ECONNREFUSED") {
    return {
      ok: false,
      reason: "daemon-refused",
      message: `Daemon did not accept the watch: ${error ?? "unknown error"}`,
    };
  }
  const daemonPid = await spawnDaemon();
  if (daemonPid) {
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const retry = await sendDaemonCommand(watchCmd);
        if (retry.ok && typeof retry.pid === "number") {
          return { ok: true, pid: retry.pid, reused: false };
        }
      } catch {}
    }
    // Still opening its stores. The daemon only kills per-project watchers at
    // startup, so one spawned now would outlive that sweep and run beside it.
    return {
      ok: false,
      reason: "daemon-refused",
      message: `Daemon (PID ${daemonPid}) is still starting; the watch will be retried`,
    };
  }

  // 5. Fall back to per-project spawn (the daemon could not be started)
  try {
    const child = spawn(
      process.argv[0],
      [process.argv[1], "watch", "--path", projectRoot, "-b"],
      { detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
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
