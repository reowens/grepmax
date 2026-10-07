import * as fs from "node:fs";
import * as path from "node:path";
import type { HostResourceSnapshot } from "../utils/host-resource";
import {
  HELPER_RESOURCE_RESERVE_MB,
  ResourceBudget,
} from "../utils/resource-budget";
import { safetyStopReason } from "../utils/safety-latch";
import { availableStoreDiskBytes } from "./maintenance-policy";

export const PRUNE_METADATA_HEADROOM_BYTES = 1024 * 1024;

/** Explicit recovery has aggregate admission without changing normal service
 * policy. Offline autostart containment is allowed; a host safety stop is not. */
export function createRecoveryBudget(): ResourceBudget {
  return new ResourceBudget({
    policy: () => "strict",
    quarantine: safetyStopReason,
    requireClientRegistration: false,
    samplerOverrides: { sampleTimeoutMs: 8000, kernelProbeTimeoutMs: 5000 },
    sampleMaxAgeMs: 10000,
  });
}

export function assertRecoveryAdmission(
  storeDir: string,
  budget: ResourceBudget,
): HostResourceSnapshot {
  const marker = path.join(
    path.dirname(fs.realpathSync(storeDir)),
    "autostart-disabled",
  );
  const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new Error(
      "Recovery requires a persistent autostart-disabled file in the store home; close store owners separately",
    );
  const disk = availableStoreDiskBytes(storeDir);
  if (!Number.isFinite(disk) || disk < PRUNE_METADATA_HEADROOM_BYTES)
    throw new Error("Prune metadata disk headroom is low or unknown");
  const snapshot = budget.check();
  if (snapshot?.platform !== "darwin")
    throw new Error(
      "Production recovery admission currently requires macOS host measurements",
    );
  if (
    snapshot.physicalFreeMb === null ||
    !Number.isFinite(snapshot.physicalFreeMb) ||
    snapshot.physicalFreeMb < HELPER_RESOURCE_RESERVE_MB
  )
    throw new Error("Insufficient measured physical headroom for prune helper");
  return snapshot;
}

export interface PruneAdmission {
  snapshot?: HostResourceSnapshot;
  start: (pid: number) => void;
  approve: () => void;
  check: () => void;
  close: () => void;
}
export function admitPrune(
  storeDir: string,
  budget = createRecoveryBudget(),
): PruneAdmission {
  assertRecoveryAdmission(storeDir, budget);
  const reserve = budget.reserve(HELPER_RESOURCE_RESERVE_MB, "prune-helper");
  let snapshot: HostResourceSnapshot;
  try {
    snapshot = assertRecoveryAdmission(storeDir, budget);
  } catch (error) {
    reserve.release();
    throw error;
  }
  return {
    snapshot,
    start: (pid) => reserve.attach(pid),
    approve: () => assertRecoveryAdmission(storeDir, budget),
    check: () => assertRecoveryAdmission(storeDir, budget),
    close: () => reserve.release(),
  };
}
