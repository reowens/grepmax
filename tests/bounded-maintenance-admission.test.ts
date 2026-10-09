import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/lib/daemon/daemon";
import {
  BOUNDED_FREE_SPACE_MARGIN_BYTES,
  BOUNDED_MAINTENANCE_BLOCKED_REASON,
  checkBoundedMaintenanceCandidate,
  MAX_BOUNDED_TOTAL_WRITE_BYTES,
  parseBoundedMaintenancePlan,
} from "../src/lib/store/bounded-maintenance";
import {
  assertStoreMutationAllowed,
  availableStoreDiskBytes,
} from "../src/lib/store/maintenance-policy";
import { resourceBudget } from "../src/lib/utils/resource-budget";

vi.mock("../src/lib/store/maintenance-policy", async (original) => ({
  ...(await original<typeof import("../src/lib/store/maintenance-policy")>()),
  assertStoreMutationAllowed: vi.fn(),
  availableStoreDiskBytes: vi.fn(),
}));
vi.mock("../src/lib/utils/resource-budget", async (original) => ({
  ...(await original<typeof import("../src/lib/utils/resource-budget")>()),
  resourceBudget: { check: vi.fn(), reserve: vi.fn() },
}));
vi.mock("../src/lib/store/bounded-runtime", () => ({
  prepareBoundedMaintenanceRuntime: vi.fn(async () => null),
}));

function candidate() {
  return {
    protocolVersion: 1,
    engine: "12.0.0",
    status: "qualified",
    expectedVersion: 7,
    planId: "a".repeat(64),
    budgetKind: "cumulative-writes",
    nativeTotalWriteBudgetEnforced: true,
    rewritten: false,
    totalWriteBudgetBytes: MAX_BOUNDED_TOTAL_WRITE_BYTES,
    freeSpaceMarginBytes: BOUNDED_FREE_SPACE_MARGIN_BYTES,
    dataWriteBoundBytes: 32 * 1024 ** 2,
    indexWriteBoundBytes: 64 * 1024 ** 2,
    metadataWriteBoundBytes: 1024 ** 2,
    verificationWriteBoundBytes: 16 * 1024 ** 2,
    totalWriteBoundBytes: 113 * 1024 ** 2,
  };
}

describe("bounded cleanup candidate admission", () => {
  afterEach(() => vi.resetAllMocks());

  it("requires space for all writes plus margin, and resamples instead of caching admission", () => {
    const p = candidate();
    const required = p.totalWriteBudgetBytes + p.freeSpaceMarginBytes;
    vi.mocked(availableStoreDiskBytes)
      .mockReturnValueOnce(required)
      .mockReturnValueOnce(required - 1);
    expect(checkBoundedMaintenanceCandidate("/fixture", p, 7)).toEqual(p);
    expect(() => checkBoundedMaintenanceCandidate("/fixture", p, 7)).toThrow(
      "headroom",
    );
    expect(availableStoreDiskBytes).toHaveBeenCalledTimes(2);
    expect(resourceBudget.check).toHaveBeenCalledOnce();
    expect(resourceBudget.reserve).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 10.5])(
    "refuses unknown or invalid free space %s",
    (free) => {
      vi.mocked(availableStoreDiskBytes).mockReturnValue(free);
      expect(() =>
        checkBoundedMaintenanceCandidate("/fixture", candidate(), 7),
      ).toThrow("headroom");
      expect(resourceBudget.check).not.toHaveBeenCalled();
    },
  );

  it("checks the configured host policy and cancellation freshly", () => {
    vi.mocked(availableStoreDiskBytes).mockReturnValue(3 * 1024 ** 3);
    vi.mocked(resourceBudget.check).mockImplementationOnce(() => {
      throw new Error("configured host policy refused");
    });
    expect(() =>
      checkBoundedMaintenanceCandidate("/fixture", candidate(), 7),
    ).toThrow("configured host policy");
    const controller = new AbortController();
    vi.mocked(resourceBudget.check).mockImplementationOnce(() => {
      controller.abort(new Error("shutdown"));
      return null;
    });
    expect(() =>
      checkBoundedMaintenanceCandidate(
        "/fixture",
        candidate(),
        7,
        controller.signal,
      ),
    ).toThrow("shutdown");
  });

  it("rejects cancellation and blocked/no-work candidates before any disk or host sample", () => {
    const controller = new AbortController();
    controller.abort(new Error("closing"));
    expect(() =>
      checkBoundedMaintenanceCandidate(
        "/fixture",
        candidate(),
        7,
        controller.signal,
      ),
    ).toThrow("closing");
    for (const status of ["blocked", "no-work"])
      expect(() =>
        checkBoundedMaintenanceCandidate(
          "/fixture",
          {
            ...candidate(),
            status,
            reason: "write bound unknown",
            nativeTotalWriteBudgetEnforced: false,
            dataWriteBoundBytes: status === "blocked" ? null : 0,
            indexWriteBoundBytes: status === "blocked" ? null : 0,
            metadataWriteBoundBytes: status === "blocked" ? null : 0,
            verificationWriteBoundBytes: status === "blocked" ? null : 0,
            totalWriteBoundBytes: status === "blocked" ? null : 0,
          },
          7,
        ),
      ).toThrow("write bound unknown");
    expect(assertStoreMutationAllowed).not.toHaveBeenCalled();
    expect(availableStoreDiskBytes).not.toHaveBeenCalled();
    expect(resourceBudget.check).not.toHaveBeenCalled();
  });

  it("refuses safety quarantine before a native candidate can be admitted", () => {
    vi.mocked(assertStoreMutationAllowed).mockImplementationOnce(() => {
      throw new Error("host safety stop");
    });
    expect(() =>
      checkBoundedMaintenanceCandidate("/fixture", candidate(), 7),
    ).toThrow("host safety stop");
    expect(availableStoreDiskBytes).not.toHaveBeenCalled();
  });

  it.each([
    { expectedVersion: 6 },
    { planId: "unverified" },
    { engine: "unknown" },
    { nativeTotalWriteBudgetEnforced: false },
    { budgetKind: "disk-growth" },
    { totalWriteBudgetBytes: MAX_BOUNDED_TOTAL_WRITE_BYTES + 1 },
    { totalWriteBudgetBytes: 32 * 1024 ** 2 },
    { freeSpaceMarginBytes: 0 },
    { indexWriteBoundBytes: Number.NaN },
    { verificationWriteBoundBytes: -1 },
    { dataWriteBoundBytes: 0 },
    { indexWriteBoundBytes: Number.MAX_SAFE_INTEGER },
  ])(
    "refuses stale, missing, overflowing or inconsistent budget %j",
    (changes) => {
      expect(() =>
        parseBoundedMaintenancePlan({ ...candidate(), ...changes }, 7),
      ).toThrow();
    },
  );

  it("freezes a copy so mutable helper output cannot lower an admitted budget", () => {
    const p = candidate();
    const parsed = parseBoundedMaintenancePlan(p, 7);
    p.totalWriteBudgetBytes = 0;
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.totalWriteBudgetBytes).toBe(MAX_BOUNDED_TOTAL_WRITE_BYTES);
  });

  it("preserves unknown native bounds as null instead of inventing an admission budget", () => {
    const blocked = {
      ...candidate(),
      status: "blocked",
      reason: "native total-write cap unavailable",
      nativeTotalWriteBudgetEnforced: false,
      dataWriteBoundBytes: null,
      indexWriteBoundBytes: null,
      metadataWriteBoundBytes: null,
      verificationWriteBoundBytes: null,
      totalWriteBoundBytes: null,
    };
    expect(parseBoundedMaintenancePlan(blocked, 7)).toEqual(blocked);
    expect(() =>
      parseBoundedMaintenancePlan({ ...blocked, dataWriteBoundBytes: 0 }, 7),
    ).toThrow("invalid or unknown");
  });
});

describe("current daemon bounded cleanup gate", () => {
  afterEach(() => vi.resetAllMocks());

  it("keeps searches, indexing and watchers open and does not claim a qualified execution", async () => {
    const daemon = new Daemon();
    const d = daemon as any;
    d.ready = true;
    const cleanupVersions = vi.fn();
    d.vectorDb = { cleanupVersions };
    d.watcherManager = { quiesceAll: vi.fn(), resumeAll: vi.fn() };
    const exclusive = vi.spyOn(d.operations, "runExclusive");
    vi.spyOn(d, "assertHeavyOperationAdmission").mockImplementation(() => {});
    await expect(daemon.runBoundedMaintenance()).resolves.toMatchObject({
      status: "skipped",
      attempts: 0,
      reason: BOUNDED_MAINTENANCE_BLOCKED_REASON,
    });
    await expect(
      d.operations.runShared("search", undefined, async () => "available"),
    ).resolves.toBe("available");
    expect(exclusive).not.toHaveBeenCalled();
    expect(d.watcherManager.quiesceAll).not.toHaveBeenCalled();
    expect(cleanupVersions).not.toHaveBeenCalled();
    expect(resourceBudget.reserve).not.toHaveBeenCalled();
    expect(availableStoreDiskBytes).not.toHaveBeenCalled();
    expect(d.assertHeavyOperationAdmission).not.toHaveBeenCalled();
    expect(daemon.operationStatus()).toBe("open");
  });
});
