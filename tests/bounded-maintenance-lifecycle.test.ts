import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseMeteredMaintenancePlan,
  runBoundedMaintenance,
} from "../src/lib/store/bounded-maintenance";
import { availableStoreDiskBytes } from "../src/lib/store/maintenance-policy";
import type { StoreLease } from "../src/lib/store/store-lease";
import { OperationCoordinator } from "../src/lib/utils/operation-coordinator";
import { resourceBudget } from "../src/lib/utils/resource-budget";

vi.mock("../src/lib/store/maintenance-policy", () => ({
  assertStoreMutationAllowed: vi.fn(),
  availableStoreDiskBytes: vi.fn(() => 10 * 1024 ** 3),
}));
vi.mock("../src/lib/utils/resource-budget", () => ({
  resourceBudget: { check: vi.fn(), reserve: vi.fn() },
}));

const plan = {
  protocolVersion: 2,
  engine: "12.0.0",
  status: "qualified",
  expectedVersion: 7,
  beforeVersion: 7,
  protectedVersion: 7,
  action: "run",
  planId: "a".repeat(64),
  budgetKind: "cumulative-writes",
  nativeTotalWriteBudgetEnforced: true,
  effectiveStoreScheme: "file-object-store",
  sharedTotalWriteCapBytes: 512 * 1024 ** 2,
  totalWriteBudgetBytes: 512 * 1024 ** 2,
  freeSpaceMarginBytes: 1024 ** 3,
};

function helper(overrides = {}, planOverrides = {}, phaseOverrides = {}) {
  const result = {
    phase: "result",
    status: "committed",
    beforeVersion: 7,
    afterVersion: 8,
    planId: plan.planId,
    receiptId: "attempt-1",
    rowsVerified: 12,
    remainingDeletedRows: 3,
    aborted: false,
    totalBytesWritten: 150,
    dataBytesWritten: 100,
    indexBytesWritten: 30,
    metadataBytesWritten: 20,
    verificationBytesWritten: 0,
    ...overrides,
  };
  return `
    const plan = ${JSON.stringify({ ...plan, ...planOverrides })};
    const result = ${JSON.stringify(result)};
    const counters = { totalBytesWritten: 0, dataBytesWritten: 0, indexBytesWritten: 0, metadataBytesWritten: 0, verificationBytesWritten: 0 };
    const phaseOverrides = ${JSON.stringify(phaseOverrides)};
    const protection = { beforeVersion: plan.beforeVersion, protectedVersion: plan.protectedVersion, afterVersion: result.afterVersion, planId: plan.planId, readerTag: "gmax-before-1", receiptId: "attempt-1" };
    let stage = 0, buffer = "";
    function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
    process.stdin.on("data", (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (stage === 0) { const request = JSON.parse(line); if(request.expectedVersion !== plan.expectedVersion || request.action !== plan.action) process.exit(10); send({ phase: "launch" }); }
        else if (line !== "fixture-nonce") process.exit(11);
        else if (stage === 1) send({ phase: "ready", plan, ...counters, ...phaseOverrides.ready });
        else if (stage === 2 && plan.status === "no-work") { send(result); process.stdin.pause(); process.exit(0); }
        else if (stage === 2) send({ phase: "protected-read-ready", ...protection, ...counters, ...phaseOverrides.protected });
        else if (stage === 3) send({ phase: "reader-drain", ...protection, ...counters, ...phaseOverrides.drain });
        else if (stage === 4) { send(result); process.stdin.pause(); process.exit(0); }
        stage++;
      }
    });
  `;
}

function fixture(overrides = {}, planOverrides = {}, phaseOverrides = {}) {
  const release = vi.fn();
  const reservation = { attach: vi.fn(), release: vi.fn() };
  vi.mocked(resourceBudget.reserve).mockReturnValue(reservation as any);
  vi.mocked(availableStoreDiskBytes).mockReturnValue(10 * 1024 ** 3);
  const lease = {
    owner: { nonce: "fixture-nonce" },
    withExclusiveUse: async (_store: string, fn: () => Promise<unknown>) =>
      await fn(),
    pinExclusiveHelper: vi.fn(() => release),
  } as unknown as StoreLease;
  return {
    lease,
    release,
    reservation,
    runtime: {
      executable: process.execPath,
      args: ["-e", helper(overrides, planOverrides, phaseOverrides)],
    },
  };
}

describe("metered native child lifecycle", () => {
  afterEach(() => vi.resetAllMocks());

  it("reports a useful native refusal category without leaking arbitrary diagnostics", async () => {
    const f = fixture({
      phase: "error",
      reason: "Index remapping cannot fit budget at /private/secret-tokens",
    });
    await expect(
      runBoundedMaintenance("/fixture", f.lease, 7, f.runtime, {
        open: vi.fn(),
        drain: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(
      "search-index updates do not fit the total-write cap; bounded cleanup completion is uncertain",
    );
  });

  it("recovers an earlier committed head using the original protection and cumulative ledger", async () => {
    const f = fixture(
      { status: "recovered" },
      {
        action: "recover",
        expectedVersion: 8,
        beforeVersion: 7,
        protectedVersion: 8,
      },
    );
    const open = vi.fn();
    const outcome = await runBoundedMaintenance(
      "/fixture",
      f.lease,
      8,
      f.runtime,
      {
        open,
        drain: vi.fn(async () => {}),
      },
      undefined,
      "recover",
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ beforeVersion: 7 }),
    );
    expect(outcome).toMatchObject({
      status: "completed",
      rewritten: false,
      beforeVersion: 7,
      afterVersion: 8,
      totalBytesWritten: 150,
    });
    expect(f.lease.pinExclusiveHelper).toHaveBeenCalledOnce();
  });

  it("reports a safely aborted copy as recovery without claiming deleted-row reclamation", async () => {
    const f = fixture(
      {
        status: "recovered",
        afterVersion: 7,
        aborted: true,
        rowsVerified: 0,
        remainingDeletedRows: 64,
      },
      {
        action: "recover",
        expectedVersion: 7,
        beforeVersion: 7,
        protectedVersion: 7,
      },
    );
    const result = await runBoundedMaintenance(
      "/fixture",
      f.lease,
      7,
      f.runtime,
      { open: vi.fn(), drain: vi.fn(async () => {}) },
      undefined,
      "recover",
    );
    expect(result).toMatchObject({
      status: "completed",
      aborted: true,
      rewritten: false,
      rowsVerified: 0,
      remainingDeletedRows: 64,
    });
    expect(result.reason).toContain("unfinished copy discarded");
  });

  it("keeps an incomplete owned-file cleanup visible as pending failure", async () => {
    const f = fixture(
      {
        status: "recovered",
        afterVersion: 7,
        aborted: true,
        rowsVerified: 0,
        recoveryPending: true,
      },
      {
        action: "recover",
        expectedVersion: 7,
        beforeVersion: 7,
        protectedVersion: 7,
      },
    );
    const result = await runBoundedMaintenance(
      "/fixture",
      f.lease,
      7,
      f.runtime,
      { open: vi.fn(), drain: vi.fn(async () => {}) },
      undefined,
      "recover",
    );
    expect(result).toMatchObject({
      status: "failed",
      recoveryPending: true,
      aborted: true,
      rewritten: false,
    });
    expect(result.reason).toContain("owned-file cleanup remains pending");
  });

  it("accepts a later current head only with durable accepted-finalization evidence", async () => {
    const p = {
      action: "recover",
      expectedVersion: 9,
      beforeVersion: 7,
      protectedVersion: 9,
    };
    const f = fixture(
      {
        status: "recovered",
        afterVersion: 9,
        verifiedCopyVersion: 8,
        acceptedFinalization: true,
      },
      p,
    );
    const open = vi.fn();
    const result = await runBoundedMaintenance(
      "/fixture",
      f.lease,
      9,
      f.runtime,
      { open, drain: vi.fn(async () => {}) },
      undefined,
      "recover",
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ beforeVersion: 7, protectedVersion: 9 }),
    );
    expect(result).toMatchObject({
      afterVersion: 9,
      verifiedCopyVersion: 8,
      acceptedFinalization: true,
      rewritten: false,
    });
    const invalid = fixture(
      {
        status: "recovered",
        afterVersion: 9,
        verifiedCopyVersion: 8,
        acceptedFinalization: false,
      },
      p,
    );
    await expect(
      runBoundedMaintenance(
        "/fixture",
        invalid.lease,
        9,
        invalid.runtime,
        { open: vi.fn(), drain: vi.fn(async () => {}) },
        undefined,
        "recover",
      ),
    ).rejects.toThrow("uncertain");
  });

  it("pins the child, opens only after durable protection and drains before finalization", async () => {
    const f = fixture();
    const events: string[] = [];
    const result = await runBoundedMaintenance(
      "/fixture",
      f.lease,
      7,
      f.runtime,
      {
        open: (p) => {
          expect(p.readerTag).toBe("gmax-before-1");
          events.push("protected");
        },
        drain: async () => {
          events.push("drained");
        },
      },
    );
    expect(events).toEqual(["protected", "drained"]);
    expect(result).toMatchObject({
      status: "completed",
      totalBytesWritten: 150,
      indexBytesWritten: 30,
      afterVersion: 8,
    });
    expect(f.lease.pinExclusiveHelper).toHaveBeenCalledOnce();
    expect(f.reservation.attach).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.reservation.release).toHaveBeenCalledOnce();
  });

  it("withholds finalization and awaits child close when a protected reader cannot drain", async () => {
    const f = fixture();
    const opened = vi.fn();
    await expect(
      runBoundedMaintenance("/fixture", f.lease, 7, f.runtime, {
        open: opened,
        drain: async () => {
          throw new Error("reader still active");
        },
      }),
    ).rejects.toThrow("uncertain");
    expect(opened).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.reservation.release).toHaveBeenCalledOnce();
  });

  it("cancels an admitted child without repeating the copy", async () => {
    const f = fixture();
    const controller = new AbortController();
    const open = vi.fn(() => controller.abort(new Error("shutdown")));
    await expect(
      runBoundedMaintenance(
        "/fixture",
        f.lease,
        7,
        f.runtime,
        {
          open,
          drain: vi.fn(async () => {}),
        },
        controller.signal,
      ),
    ).rejects.toThrow("uncertain");
    expect(open).toHaveBeenCalledOnce();
    expect(f.lease.pinExclusiveHelper).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("resamples full disk admission at the ready handshake", async () => {
    const f = fixture();
    vi.mocked(availableStoreDiskBytes)
      .mockReturnValueOnce(10 * 1024 ** 3)
      .mockReturnValueOnce(10 * 1024 ** 3)
      .mockReturnValueOnce(10 * 1024 ** 3)
      .mockReturnValue(1);
    const open = vi.fn();
    await expect(
      runBoundedMaintenance("/fixture", f.lease, 7, f.runtime, {
        open,
        drain: vi.fn(async () => {}),
      }),
    ).rejects.toThrow("uncertain");
    expect(open).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("admits its remaining allowance after its own copy consumes the reserved space", async () => {
    const counters = {
      totalBytesWritten: plan.totalWriteBudgetBytes - 1024,
      dataBytesWritten: plan.totalWriteBudgetBytes - 1074,
      indexBytesWritten: 30,
      metadataBytesWritten: 20,
      verificationBytesWritten: 0,
    };
    const f = fixture(counters, {}, { drain: counters });
    vi.mocked(availableStoreDiskBytes).mockReturnValue(
      plan.totalWriteBudgetBytes + plan.freeSpaceMarginBytes,
    );
    const result = await runBoundedMaintenance(
      "/fixture",
      f.lease,
      7,
      f.runtime,
      {
        async open() {
          vi.mocked(availableStoreDiskBytes).mockReturnValue(
            plan.freeSpaceMarginBytes + 1024,
          );
          // Exercise the active monitor while the authoritative ledger spends.
          await new Promise((resolve) => setTimeout(resolve, 1100));
        },
        drain: vi.fn(async () => {}),
      },
    );
    expect(result.totalBytesWritten).toBe(counters.totalBytesWritten);
    expect(result.status).toBe("completed");
  });

  it("restores recovery counters before admitting only the original remaining cap", async () => {
    const counters = {
      totalBytesWritten: plan.totalWriteBudgetBytes - 1024,
      dataBytesWritten: plan.totalWriteBudgetBytes - 1074,
      indexBytesWritten: 30,
      metadataBytesWritten: 20,
      verificationBytesWritten: 0,
    };
    const f = fixture(
      { ...counters, status: "recovered" },
      { action: "recover", expectedVersion: 8, protectedVersion: 8 },
      { ready: counters, protected: counters, drain: counters },
    );
    vi.mocked(availableStoreDiskBytes).mockReturnValue(
      plan.freeSpaceMarginBytes + 1024,
    );
    const result = await runBoundedMaintenance(
      "/fixture",
      f.lease,
      8,
      f.runtime,
      { open: vi.fn(), drain: vi.fn(async () => {}) },
      undefined,
      "recover",
    );
    expect(result.totalBytesWritten).toBe(counters.totalBytesWritten);
    expect(result.rewritten).toBe(false);
  });

  it("refuses refunded, incomplete or excessive restored phase counters", async () => {
    for (const change of [
      { totalBytesWritten: 99 },
      { dataBytesWritten: -1 },
      {
        totalBytesWritten: plan.totalWriteBudgetBytes + 1,
        dataBytesWritten: plan.totalWriteBudgetBytes + 1,
      },
    ]) {
      const f = fixture({}, {}, { ready: change });
      await expect(
        runBoundedMaintenance("/fixture", f.lease, 7, f.runtime, {
          open: vi.fn(),
          drain: vi.fn(async () => {}),
        }),
      ).rejects.toThrow("uncertain");
    }
    const f = fixture(
      {},
      {},
      {
        protected: { totalBytesWritten: 20, metadataBytesWritten: 20 },
      },
    );
    await expect(
      runBoundedMaintenance("/fixture", f.lease, 7, f.runtime, {
        open: vi.fn(),
        drain: vi.fn(async () => {}),
      }),
    ).rejects.toThrow("uncertain");
  });

  it("accepts an omitted protection version only when no native work opens a window", async () => {
    const f = fixture(
      {
        status: "no-work",
        afterVersion: 7,
        totalBytesWritten: 0,
        dataBytesWritten: 0,
        indexBytesWritten: 0,
        metadataBytesWritten: 0,
        rowsVerified: 0,
      },
      { status: "no-work", protectedVersion: undefined },
    );
    const open = vi.fn();
    const result = await runBoundedMaintenance(
      "/fixture",
      f.lease,
      7,
      f.runtime,
      {
        open,
        drain: vi.fn(async () => {}),
      },
    );
    expect(result.status).toBe("skipped");
    expect(open).not.toHaveBeenCalled();
    expect(() =>
      parseMeteredMaintenancePlan({ ...plan, protectedVersion: undefined }, 7),
    ).toThrow();
  });

  it("does not require any rewrite reserve for a proven empty recovery", async () => {
    const f = fixture(
      {
        status: "no-work",
        afterVersion: 7,
        totalBytesWritten: 0,
        dataBytesWritten: 0,
        indexBytesWritten: 0,
        metadataBytesWritten: 0,
        rowsVerified: 0,
        recoveryPending: false,
      },
      { status: "no-work", action: "recover" },
    );
    vi.mocked(availableStoreDiskBytes).mockReturnValue(
      plan.freeSpaceMarginBytes,
    );
    const result = await runBoundedMaintenance(
      "/fixture",
      f.lease,
      7,
      f.runtime,
      { open: vi.fn(), drain: vi.fn(async () => {}) },
      undefined,
      "recover",
    );
    expect(result.status).toBe("skipped");
    expect(result.recoveryPending).toBe(false);
    expect(result.totalBytesWritten).toBe(0);
  });

  it.each([
    { totalBytesWritten: 151 },
    { indexBytesWritten: -1 },
    {
      totalBytesWritten: 600 * 1024 ** 2,
      dataBytesWritten: 600 * 1024 ** 2 - 50,
    },
    { afterVersion: 6 },
    { receiptId: "different-attempt" },
  ])("refuses malformed or excessive final evidence %j", async (changes) => {
    const f = fixture(changes);
    await expect(
      runBoundedMaintenance("/fixture", f.lease, 7, f.runtime, {
        open: vi.fn(),
        drain: vi.fn(async () => {}),
      }),
    ).rejects.toThrow("uncertain");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("rejects a claimed shared cap that routes through the ordinary unmetered file store", () => {
    expect(() =>
      parseMeteredMaintenancePlan({ ...plan, effectiveStoreScheme: "file" }, 7),
    ).toThrow("enforcement");
    expect(() =>
      parseMeteredMaintenancePlan({ ...plan, sharedTotalWriteCapBytes: 1 }, 7),
    ).toThrow("enforcement");
    expect(parseMeteredMaintenancePlan(plan, 7).sharedTotalWriteCapBytes).toBe(
      512 * 1024 ** 2,
    );
  });
});

describe("protected read windows for head-changing cleanup", () => {
  it("keeps reads available before writers quiesce, drains old reads, and protects new reads until final drain", async () => {
    const operations = new OperationCoordinator();
    let releaseQuiesce!: () => void;
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    const quiesce = new Promise<void>((resolve) => (releaseQuiesce = resolve));
    const events: string[] = [];
    const cleanup = operations.runExclusive(
      "bounded-maintenance",
      () => quiesce,
      async () => {
        operations.openProtectedMaintenanceReadWindow(
          {
            beforeVersion: 7,
            readerTag: "gmax-before",
            receiptId: "attempt-1",
          },
          (name) => name === "search",
        );
        const current = operations.runShared(
          "search",
          undefined,
          () =>
            new Promise<void>((resolve) => {
              releaseRead = resolve;
              readStarted();
            }),
        );
        await started;
        const drain = operations.closeProtectedMaintenanceReadWindow();
        events.push("protected");
        await Promise.resolve();
        expect(events).toEqual(["protected"]);
        releaseRead();
        await current;
        await drain;
        events.push("drained");
      },
      {
        queueShared: true,
        pendingReads: (name) => name === "search",
        readerDrainTimeoutMs: 50,
      },
    );
    await expect(
      operations.runShared("search", undefined, async () => "before quiesce"),
    ).resolves.toBe("before quiesce");
    releaseQuiesce();
    await cleanup;
    expect(events).toEqual(["protected", "drained"]);
    expect(operations.status).toBe("open");
  });

  it("refuses before native mutation if an old reader never settles", async () => {
    const operations = new OperationCoordinator();
    let release!: () => void;
    const read = operations.runShared(
      "search",
      undefined,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const native = vi.fn(async () => {});
    await expect(
      operations.runExclusive("bounded-maintenance", async () => {}, native, {
        queueShared: true,
        pendingReads: (name) => name === "search",
        readerDrainTimeoutMs: 5,
      }),
    ).rejects.toThrow("drain timed out");
    expect(native).not.toHaveBeenCalled();
    expect(operations.status).toBe("open");
    await expect(
      operations.runShared("search", undefined, async () => "available"),
    ).resolves.toBe("available");
    release();
    await read;
  });
});
