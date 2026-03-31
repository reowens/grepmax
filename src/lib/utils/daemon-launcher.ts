import { spawn } from "node:child_process";
import * as path from "node:path";
import { PATHS } from "../../config";
import { openRotatedLog } from "./log-rotate";

/**
 * Spawn the daemon in background mode.
 * Returns the child PID, or null on failure.
 */
export function spawnDaemon(): number | null {
  try {
    const logFile = path.join(PATHS.logsDir, "daemon.log");
    const out = openRotatedLog(logFile);

    const child = spawn(
      process.argv[0],
      [process.argv[1], "watch", "--daemon", "-b"],
      { detached: true, stdio: ["ignore", out, out] },
    );
    child.unref();

    return child.pid ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[daemon-launcher] Failed to spawn daemon: ${msg}`);
    return null;
  }
}
