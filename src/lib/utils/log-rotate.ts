import * as fs from "node:fs";
import * as path from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Open a log file with rotation. Creates parent directories if needed.
 * Rotates {name}.log -> {name}.log.prev when size exceeds maxBytes.
 * Returns an fd suitable for stdio redirection.
 */
export function openRotatedLog(
  logPath: string,
  maxBytes: number = MAX_LOG_BYTES,
): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  try {
    const stat = fs.statSync(logPath);
    if (stat.size > maxBytes) {
      fs.renameSync(logPath, `${logPath}.prev`);
    }
  } catch {}

  return fs.openSync(logPath, "a");
}

/**
 * Mid-session log rotation for daemon processes.
 * Renames the log to .prev and reopens stdout/stderr (fd 1, 2) to a fresh file.
 * Safe on Unix: synchronous close/open guarantees fd 1 and 2 are reassigned.
 */
export function rotateLogFds(
  logPath: string,
  maxBytes: number = MAX_LOG_BYTES,
): boolean {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= maxBytes) return false;
  } catch {
    return false;
  }

  try {
    fs.renameSync(logPath, `${logPath}.prev`);
    fs.closeSync(1);
    fs.closeSync(2);
    fs.openSync(logPath, "a"); // gets fd 1 (stdout)
    fs.openSync(logPath, "a"); // gets fd 2 (stderr)
    return true;
  } catch {
    return false;
  }
}
