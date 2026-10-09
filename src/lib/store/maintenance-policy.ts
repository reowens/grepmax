import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DISK_CRITICAL_BYTES } from "../../config";
import { autostartDisabledReason } from "../utils/autostart";
import { safetyStopReason } from "../utils/safety-latch";

export const FULL_TABLE_MAINTENANCE_DISABLED_REASON =
  "full-table maintenance disabled by host-safety containment; version cleanup runs independently";

/** This release has no production override: force, configuration and persisted
 * state cannot enable rewriting. Tests may mock this module to cover the old
 * native algorithm without turning it into a supported production entry point. */
export function fullTableMaintenanceDisabled(): boolean {
  return true;
}

export class DiskPressureError extends Error {
  constructor(message = "Disk critically low or unknown — writes suspended") {
    super(message);
    this.name = "DiskPressureError";
  }
}

/** Fresh, bounded filesystem sample. ENOENT alone permits trying an ancestor;
 * permission errors, invalid values and all other uncertainty refuse writes. */
export function availableStoreDiskBytes(storeDir: string): number {
  let existing = path.resolve(storeDir);
  for (;;) {
    try {
      const stats = fs.statfsSync(existing);
      const available = stats.bavail * stats.bsize;
      return Number.isFinite(available) && available >= 0
        ? available
        : Number.NaN;
    } catch (error) {
      const parent = path.dirname(existing);
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        parent === existing
      )
        return Number.NaN;
      existing = parent;
    }
  }
}

/** Reusable admission for LMDB and other store mutations. Never cached. */
export function assertFreshDiskMutationAllowed(storeDir: string): number {
  const available = availableStoreDiskBytes(storeDir);
  if (!Number.isFinite(available) || available < DISK_CRITICAL_BYTES)
    throw new DiskPressureError();
  return available;
}

export function storeMutationDeniedReason(): string | null {
  const safety = safetyStopReason();
  if (safety !== null) return `host safety stop: ${safety}`;
  return autostartDisabledReason() !== null
    ? "store mutations are quarantined while daemon autostart is disabled"
    : null;
}

export function assertStoreMutationAllowed(): void {
  const reason = storeMutationDeniedReason();
  if (reason !== null)
    throw new Error(`gmax store mutation blocked: ${reason}`);
}

export interface StoreMaintenancePolicy {
  schemaVersion: 1;
  storeIdentity: string;
  mode: "disabled";
  reason: string;
  recordedAt: number;
  rewriteBudgetBytes: 0;
  cleanupPending: boolean;
  lastVersionCleanupAt?: number;
}

export function maintenancePolicyPath(storeDir: string): string {
  return path.join(storeDir, ".gmax-maintenance-policy.json");
}

/** Persist a zero-rewrite receipt once. Unknown/corrupt/unwritable state never
 * weakens the immutable default. No timestamps or budgets authorize native work. */
export function recordMaintenanceContainment(storeDir: string): string {
  let temporary: string | undefined;
  try {
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const storeIdentity = fs.realpathSync(storeDir);
    const target = maintenancePolicyPath(storeIdentity);
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.size > 16 * 1024)
        throw new Error("unsafe maintenance policy file");
      const previous = JSON.parse(fs.readFileSync(target, "utf8"));
      if (
        previous.schemaVersion === 1 &&
        previous.storeIdentity === storeIdentity &&
        previous.mode === "disabled" &&
        previous.rewriteBudgetBytes === 0 &&
        typeof previous.cleanupPending === "boolean" &&
        previous.reason === FULL_TABLE_MAINTENANCE_DISABLED_REASON
      ) {
        fs.chmodSync(target, 0o600);
        return FULL_TABLE_MAINTENANCE_DISABLED_REASON;
      }
    }
    const policy: StoreMaintenancePolicy = {
      schemaVersion: 1,
      storeIdentity,
      mode: "disabled",
      reason: FULL_TABLE_MAINTENANCE_DISABLED_REASON,
      recordedAt: Date.now(),
      rewriteBudgetBytes: 0,
      cleanupPending: true,
    };
    temporary = path.join(
      storeIdentity,
      `.gmax-maintenance-${randomUUID()}.tmp`,
    );
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(policy)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
    temporary = undefined;
    const directory = fs.openSync(storeIdentity, "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    return FULL_TABLE_MAINTENANCE_DISABLED_REASON;
  } catch {
    return `${FULL_TABLE_MAINTENANCE_DISABLED_REASON}; persistent policy unavailable or invalid (still disabled)`;
  } finally {
    if (temporary) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Failed receipt cleanup cannot authorize maintenance.
      }
    }
  }
}

/** A completed prune changes retention state, never enables table rewrites. */
export function recordVersionCleanupCompleted(
  storeDir: string,
  at: number,
): void {
  recordMaintenanceContainment(storeDir);
  const identity = fs.realpathSync(storeDir);
  const target = maintenancePolicyPath(identity);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.size > 16 * 1024)
    throw new Error("maintenance receipt is unverified");
  const policy: StoreMaintenancePolicy = JSON.parse(
    fs.readFileSync(target, "utf8"),
  );
  if (
    policy.storeIdentity !== identity ||
    policy.mode !== "disabled" ||
    policy.rewriteBudgetBytes !== 0 ||
    !Number.isSafeInteger(at)
  )
    throw new Error("maintenance receipt is invalid");
  const temporary = path.join(
    identity,
    `.gmax-maintenance-${randomUUID()}.tmp`,
  );
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ ...policy, cleanupPending: false, lastVersionCleanupAt: at })}\n`,
      );
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
    const directory = fs.openSync(identity, "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
