import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import { openRotatedLog } from "./log-rotate";

/**
 * Spawn the daemon in background mode.
 * Returns the child PID, or null on failure.
 */
export async function spawnDaemon(): Promise<number | null> {
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
