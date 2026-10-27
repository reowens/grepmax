import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import { isGemma2Profile } from "../workers/embeddings/gemma2";
import { daemonStartDeniedReason } from "./autostart";
import { openRotatedLog } from "./log-rotate";
import {
  installedUserDaemonService,
  startUserDaemonService,
} from "./service-startup";

/**
 * Spawn the daemon in background mode.
 * Returns the child PID, or null on failure.
 */
export async function spawnDaemon(): Promise<number | null> {
  if (isGemma2Profile(PATHS.globalRoot) || daemonStartDeniedReason() !== null)
    return null;
  // Keep errors visible: null permits watcher-launcher to start a per-project
  // watcher, which would escape an installed service's resource limits too.
  const unit = installedUserDaemonService();
  if (unit) return startUserDaemonService(unit);
  let out: number | null = null;
  try {
    const logFile = path.join(PATHS.logsDir, "daemon.log");
    out = openRotatedLog(logFile);

    const child = spawn(
      process.argv[0],
      [process.argv[1], "watch", "--daemon", "-b"],
      { detached: true, stdio: ["ignore", out, out] },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();

    return child.pid ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[daemon-launcher] Failed to spawn daemon: ${msg}`);
    return null;
  } finally {
    if (out !== null) {
      try {
        fs.closeSync(out);
      } catch {}
    }
  }
}

/**
 * Spawn the daemon itself (`watch --daemon`, not the `-b` launcher), detached,
 * logging to daemon.log. Resolves to the daemon's own PID; throws when the
 * spawn fails.
 */
export async function spawnDaemonProcess(
  options: { readOnly?: boolean } = {},
): Promise<{
  pid: number;
  logFile: string;
  service?: string;
}> {
  if (isGemma2Profile(PATHS.globalRoot))
    throw new Error(
      "Gemma profiles run in-process; daemon startup is disabled",
    );
  const denied = daemonStartDeniedReason();
  if (denied !== null && !options.readOnly) throw new Error(`gmax: ${denied}`);
  const unit = installedUserDaemonService();
  if (unit) {
    const pid = await startUserDaemonService(unit, options);
    return {
      pid,
      logFile: path.join(PATHS.logsDir, "daemon.log"),
      service: unit,
    };
  }
  const logFile = path.join(PATHS.logsDir, "daemon.log");
  const out = openRotatedLog(logFile);
  try {
    const child = spawn(
      process.argv[0],
      [
        process.argv[1],
        "watch",
        "--daemon",
        ...(options.readOnly ? ["--read-only"] : []),
      ],
      {
        detached: true,
        stdio: ["ignore", out, out],
        cwd: process.cwd(),
        env: { ...process.env, GMAX_BACKGROUND: "true" },
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    if (child.pid === undefined) throw new Error("spawned without a PID");
    return { pid: child.pid, logFile };
  } finally {
    try {
      fs.closeSync(out);
    } catch {}
  }
}
