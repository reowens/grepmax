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
