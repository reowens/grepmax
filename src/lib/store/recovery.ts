import * as fs from "node:fs";
import * as path from "node:path";
import {
  HELPER_RESOURCE_RESERVE_MB,
  type ResourceReservation,
} from "../utils/resource-budget";
import { prepareCleanupRuntime, pruneVersions } from "./lance-cleanup";
import { readPruneState } from "./prune-state";
import {
  assertRecoveryAdmission,
  createRecoveryBudget,
} from "./recovery-admission";
import { StoreLease, StoreLeaseTimeoutError } from "./store-lease";

export interface RecoveryRequest {
  table: string;
  prune?: boolean;
  check?: boolean;
  version?: number;
  cutoff?: Date;
  acknowledgeUncertain?: string;
  signal?: AbortSignal;
}

export async function recoverStore(request: RecoveryRequest) {
  request.signal?.throwIfAborted();
  const input = path.resolve(request.table);
  const stat = fs.lstatSync(input);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !input.endsWith(".lance"))
    throw new Error(
      "Recovery requires an existing local Lance table directory, without a table symlink",
    );
  const table = fs.realpathSync(input);
  const store = path.dirname(table);
  const previous = readPruneState(store);
  if (!request.prune && !request.check)
    return {
      outcome: "status",
      table,
      state: previous,
      fullTableRewriting: "disabled",
    };
  if (
    request.prune &&
    (!Number.isSafeInteger(request.version) ||
      request.version! < 1 ||
      !request.cutoff ||
      !Number.isSafeInteger(request.cutoff.getTime()) ||
      request.cutoff.getTime() > Date.now())
  )
    throw new Error(
      "Explicit prune requires a positive --version and a real, nonfuture --cutoff",
    );
  if (
    request.prune &&
    previous?.outcome === "uncertain" &&
    request.acknowledgeUncertain !== previous.attemptId
  )
    throw new Error(
      `Previous prune completion is uncertain; inspect retained state, then use --acknowledge-uncertain ${previous.attemptId} for a verified explicit retry`,
    );
  const budget = createRecoveryBudget();
  assertRecoveryAdmission(store, budget);
  if (!request.prune)
    return {
      outcome: "admitted",
      table,
      state: previous,
      fullTableRewriting: "disabled",
    };

  // Setup is admitted and monitored before acquiring store exclusion. No owner
  // is killed and no marker is created or cleared by recovery itself.
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) controller.abort();
  let setup: ResourceReservation | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let lease: StoreLease | undefined;
  try {
    setup = budget.reserve(HELPER_RESOURCE_RESERVE_MB, "prune-runtime-setup");
    monitor = setInterval(() => {
      try {
        assertRecoveryAdmission(store, budget);
      } catch {
        controller.abort();
      }
    }, 5000);
    const runtime = await prepareCleanupRuntime(controller.signal);
    clearInterval(monitor);
    setup.release();
    assertRecoveryAdmission(store, budget);
    lease = await StoreLease.acquireExclusive({
      storeDir: store,
      timeoutMs: 1000,
      signal: controller.signal,
      role: "explicit-prune-recovery",
    });
    // Another completed/interrupted attempt may have happened during setup.
    const current = readPruneState(store);
    if (
      current?.outcome === "uncertain" &&
      request.acknowledgeUncertain !== current.attemptId
    )
      throw new Error(
        `Prune completion is uncertain; inspect and acknowledge attempt ${current.attemptId} before retry`,
      );
    assertRecoveryAdmission(store, budget);
    const result = await pruneVersions(
      runtime,
      table,
      request.version!,
      request.cutoff!,
      {
        lease,
        signal: controller.signal,
        acknowledgeUncertain: request.acknowledgeUncertain,
      },
    );
    return {
      outcome: "verified",
      table,
      state: readPruneState(store),
      result,
      allocatedBytesRecovered:
        result.allocatedBytesBefore - result.allocatedBytesAfter,
      filesystemFreeBytesChange: result.freeBytesAfter - result.freeBytesBefore,
      fullTableRewriting: "disabled",
    };
  } catch (error) {
    if (error instanceof StoreLeaseTimeoutError)
      throw new Error(
        `Recovery refused: store owners are live or unknown (${error.blockers.map((owner) => `${owner.role} pid=${owner.pid}`).join(", ") || "unverified owner"}); close them separately`,
      );
    throw error;
  } finally {
    clearInterval(monitor);
    request.signal?.removeEventListener("abort", abort);
    setup?.release();
    await lease?.release();
  }
}
