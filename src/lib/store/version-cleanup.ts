import * as path from "node:path";
import { resourceBudget } from "../utils/resource-budget";
import type { CompactionResult } from "./compaction-result";
import {
  type CleanupRuntime,
  prepareCleanupRuntime,
  pruneVersions,
} from "./lance-cleanup";
import {
  assertStoreMutationAllowed,
  availableStoreDiskBytes,
  recordVersionCleanupCompleted,
} from "./maintenance-policy";
import type { StoreLease } from "./store-lease";

export const VERSION_RETENTION_MS = 2 * 60_000;
export const MAX_CLEANUP_VERSIONS = 128;

export interface VersionCleanupResult extends CompactionResult {
  rewritten: false;
  versionsRemoved: number;
  eligibleVersionsRemaining: number;
}

function check(storeDir: string, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  assertStoreMutationAllowed();
  const free = availableStoreDiskBytes(storeDir);
  // Reclamation needs metadata space, never room for a second copy of the table.
  if (!Number.isFinite(free) || free < 1024 ** 2)
    throw new Error("version cleanup metadata disk headroom unavailable");
  resourceBudget.check();
}

/** Prepare before pausing service. Runtime downloads never hold store ownership. */
export async function prepareVersionCleanup(
  storeDir: string,
  signal?: AbortSignal,
): Promise<CleanupRuntime> {
  check(storeDir, signal);
  const reservation = resourceBudget.reserve(512, "cleanup-runtime");
  try {
    return await prepareCleanupRuntime(signal);
  } finally {
    reservation.release();
  }
}

/** Independent retention: no optimizer, compaction plan or rewrite admission. */
export async function runVersionCleanup(
  storeDir: string,
  lease: StoreLease,
  version: number,
  runtime: CleanupRuntime,
  signal?: AbortSignal,
): Promise<VersionCleanupResult> {
  const started = Date.now();
  check(storeDir, signal);
  const reservation = resourceBudget.reserve(512, "version-cleanup");
  try {
    const result = await pruneVersions(
      runtime,
      path.join(storeDir, "chunks.lance"),
      version,
      new Date(Date.now() - VERSION_RETENTION_MS),
      {
        lease,
        signal,
        maxVersions: MAX_CLEANUP_VERSIONS,
        retryUncertain: true,
        admission: {
          start: (pid) => reservation.attach(pid),
          approve: () => check(storeDir, signal),
          check: () => check(storeDir, signal),
          close: () => reservation.release(),
        },
      },
    );
    const outcome: VersionCleanupResult = {
      status: "completed",
      reason: "old versions reclaimed without rewriting data",
      at: Date.now(),
      attempts: 1,
      elapsedMs: Date.now() - started,
      rewritten: false,
      versionsRemoved: result.versionsRemoved,
      eligibleVersionsRemaining: result.eligibleVersionsRemaining ?? 0,
      diskBytesBefore: result.allocatedBytesBefore,
      diskBytesAfter: result.allocatedBytesAfter,
      freeBytesBefore: result.freeBytesBefore,
      freeBytesAfter: result.freeBytesAfter,
      bytesReclaimed: result.bytesRemoved,
      netBytesReclaimed:
        result.allocatedBytesBefore - result.allocatedBytesAfter,
      cleanupPasses: 1,
    };
    recordVersionCleanupCompleted(storeDir, outcome.at);
    return outcome;
  } finally {
    reservation.release();
  }
}
