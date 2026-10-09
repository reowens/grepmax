import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import {
  type SafetyStopDiagnostics,
  sanitizeStopDiagnostics,
} from "./pressure-diagnostics";

/** Machine-wide stop: changing stores or installing a version cannot clear it. */
export const SAFETY_LATCH_NAME = "safety-stop.json";
export interface SafetyLatch {
  schemaVersion: 1;
  at: number;
  reason: string;
  diagnostics?: SafetyStopDiagnostics;
}

function safetyRoot(): string {
  return PATHS.sharedRoot ?? path.dirname(PATHS.autostartDisabledFile);
}

/** Absence is distinct from an unreadable/corrupt stop, which stays stopped. */
export function safetyStopReason(root = safetyRoot()): string | null {
  const file = path.join(root, SAFETY_LATCH_NAME);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8192) return "unverified safety stop";
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as SafetyLatch;
    if (
      value.schemaVersion !== 1 ||
      !Number.isFinite(value.at) ||
      typeof value.reason !== "string" ||
      !value.reason.trim()
    )
      return "unverified safety stop";
    return value.reason.replace(/[\r\n\t]/g, " ").slice(0, 512);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : "unreadable safety stop";
  }
}

/** Atomic durable latch; intentionally no automatic expiry or clear operation. */
export function latchSafetyStop(
  reason: string,
  root = safetyRoot(),
  diagnostics?: SafetyStopDiagnostics,
): void {
  if (safetyStopReason(root) !== null) return;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const file = path.join(root, SAFETY_LATCH_NAME);
  const temporary = path.join(root, `.safety-stop-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    const record: SafetyLatch = {
      schemaVersion: 1,
      at: Date.now(),
      reason:
        reason.replace(/[\r\n\t]/g, " ").slice(0, 512) || "host safety stop",
      diagnostics: diagnostics
        ? sanitizeStopDiagnostics(diagnostics)
        : undefined,
    };
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Publish without replacing another concurrent stop's original cause.
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Persist the directory entry, not only the payload, before stopping.
    const dir = fs.openSync(root, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

export function assertNoSafetyStop(): void {
  const reason = safetyStopReason();
  if (reason !== null)
    throw new Error(
      `gmax safety stop: ${reason}; containment must be reviewed before resuming`,
    );
}
