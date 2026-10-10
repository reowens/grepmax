import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/lib/daemon/daemon";
import { boundedMaintenanceReceiptState } from "../src/lib/store/bounded-maintenance";
import { prepareBoundedMaintenanceRuntime } from "../src/lib/store/bounded-runtime";
import { resourceBudget } from "../src/lib/utils/resource-budget";

vi.mock("../src/lib/store/bounded-maintenance", async (original) => ({
  ...(await original<typeof import("../src/lib/store/bounded-maintenance")>()),
  boundedMaintenanceReceiptState: vi.fn(() => "missing"),
}));

vi.mock("../src/lib/store/bounded-runtime", () => ({
  prepareBoundedMaintenanceRuntime: vi.fn(async () => ({
    executable: "fixture",
  })),
}));
vi.mock("../src/lib/store/version-cleanup", async (original) => ({
  ...(await original<typeof import("../src/lib/store/version-cleanup")>()),
  prepareVersionCleanup: vi.fn(async () => ({
    python: "fixture",
    script: "prune.py",
  })),
}));

const completed = { status: "completed", at: 1, attempts: 1, elapsedMs: 1 };
function fixture() {
  const daemon = new Daemon();
  const d = daemon as any;
  d.ready = true;
  d.vectorDb = {
    cleanupDeletedRows: vi.fn(async () => completed),
    cleanupVersions: vi.fn(async () => ({
      ...completed,
      eligibleVersionsRemaining: 0,
    })),
    versionCleanupStatus: () => ({
      ...completed,
      eligibleVersionsRemaining: 0,
    }),
    close: vi.fn(async () => {}),
  };
  d.processors.set("/fixture", {});
  d.watcherManager = {
    quiesceAll: vi.fn(async () => {}),
    resumeAll: vi.fn(async () => {}),
    catchupAll: vi.fn(async () => {}),
  };
  vi.spyOn(d, "assertHeavyOperationAdmission").mockImplementation(() => {});
  vi.spyOn(resourceBudget, "check").mockImplementation(() => null);
  return { daemon, d };
}

describe("daemon bounded deleted-row cleanup lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.mocked(boundedMaintenanceReceiptState).mockReturnValue("missing");
  });

  it("recovers a pending startup receipt before any writers or watcher work", async () => {
    const { d } = fixture();
    d.ready = false;
    vi.mocked(boundedMaintenanceReceiptState).mockReturnValue("pending");
    d.vectorDb.cleanupDeletedRows.mockResolvedValue({
      ...completed,
      recoveryPending: false,
      aborted: true,
      remainingDeletedRows: 64,
    });
    await d.recoverBoundedMaintenanceBeforeWriters("/fixture");
    expect(d.vectorDb.cleanupDeletedRows.mock.calls[0][3]).toBe("recover");
    expect(d.pausedReason).toBeNull();
    expect(d.ready).toBe(false);
    expect(d.workerPool).toBeNull();
    expect(d.watcherManager.quiesceAll).not.toHaveBeenCalled();
    expect(d.lastBoundedCleanupOutcome).toMatchObject({
      aborted: true,
      remainingDeletedRows: 64,
    });
  });

  it.each(["missing", "finalized"] as const)(
    "does not require a helper for %s historical startup state",
    async (state) => {
      const { d } = fixture();
      d.ready = false;
      vi.mocked(boundedMaintenanceReceiptState).mockReturnValue(state);
      vi.mocked(prepareBoundedMaintenanceRuntime).mockResolvedValueOnce(null);
      await d.recoverBoundedMaintenanceBeforeWriters("/fixture");
      expect(prepareBoundedMaintenanceRuntime).not.toHaveBeenCalled();
      expect(d.vectorDb.cleanupDeletedRows).not.toHaveBeenCalled();
      expect(d.pausedReason).toBeNull();
      // This path never consumes the one-shot absent-helper setup.
      vi.mocked(prepareBoundedMaintenanceRuntime)
        .mockReset()
        .mockResolvedValue({ executable: "fixture" });
    },
  );

  it.each(["corrupt", "missing helper", "recover error", "pending result"])(
    "keeps bounded startup reads and exposes pending state after %s",
    async (failure) => {
      const { d } = fixture();
      d.ready = false;
      const before = d.vectorDb;
      vi.mocked(boundedMaintenanceReceiptState).mockReturnValue(
        failure === "corrupt" ? "unknown" : "pending",
      );
      if (failure === "missing helper")
        vi.mocked(prepareBoundedMaintenanceRuntime).mockResolvedValueOnce(null);
      else if (failure === "pending result")
        before.cleanupDeletedRows.mockResolvedValue({
          ...completed,
          recoveryPending: true,
        });
      else before.cleanupDeletedRows.mockRejectedValue(new Error(failure));
      await d.recoverBoundedMaintenanceBeforeWriters("/fixture");
      expect(d.pausedReason).toMatch(/requires native recovery/);
      expect(before.close).toHaveBeenCalledOnce();
      expect(d.vectorDb).not.toBe(before);
      expect(d.lastBoundedCleanupOutcome).toMatchObject({
        status: "failed",
        recoveryPending: true,
        reason: expect.stringContaining("startup deleted-row recovery pending"),
      });
      expect(d.workerPool).toBeNull();
      expect(d.watcherManager.quiesceAll).not.toHaveBeenCalled();
      await d.vectorDb.close();
    },
  );

  it("runs bounded work after ten minutes while preserving independent history cadence", async () => {
    vi.useFakeTimers();
    const { d } = fixture();
    d.startVersionCleanupLoop();
    d.startBoundedCleanupLoop();
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(d.vectorDb.cleanupDeletedRows).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(d.vectorDb.cleanupDeletedRows).toHaveBeenCalledOnce();
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.vectorDb.cleanupDeletedRows).toHaveBeenCalledTimes(2);
    clearInterval(d.cleanupInterval);
    clearInterval(d.boundedCleanupInterval);
  });

  it("gives history backlog priority and keeps reads open while bounded work defers", async () => {
    vi.useFakeTimers();
    const { d } = fixture();
    let backlog = 20;
    d.vectorDb.versionCleanupStatus = () => ({
      ...completed,
      eligibleVersionsRemaining: backlog,
    });
    d.startVersionCleanupLoop();
    d.startBoundedCleanupLoop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(d.vectorDb.cleanupDeletedRows).not.toHaveBeenCalled();
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledTimes(10);
    await expect(
      d.operations.runShared("search", undefined, async () => "open"),
    ).resolves.toBe("open");
    backlog = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.vectorDb.cleanupDeletedRows).toHaveBeenCalledOnce();
    clearInterval(d.cleanupInterval);
    clearInterval(d.boundedCleanupInterval);
  });

  it("does not repeatedly prepare unavailable helpers or pause reads/watchers", async () => {
    vi.useFakeTimers();
    const { d } = fixture();
    vi.mocked(prepareBoundedMaintenanceRuntime).mockResolvedValueOnce(null);
    d.startBoundedCleanupLoop();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    d.lastCleanupAttempt = Date.now();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prepareBoundedMaintenanceRuntime).toHaveBeenCalledOnce();
    expect(d.lastBoundedCleanupOutcome).toMatchObject({
      status: "skipped",
      attempts: 0,
    });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(prepareBoundedMaintenanceRuntime).toHaveBeenCalledOnce();
    expect(d.watcherManager.quiesceAll).not.toHaveBeenCalled();
    expect(d.vectorDb.cleanupDeletedRows).not.toHaveBeenCalled();
    await expect(
      d.operations.runShared("search", undefined, async () => "available"),
    ).resolves.toBe("available");
    clearInterval(d.boundedCleanupInterval);
  });

  it("does not enter preparation or query gates on scheduled bulk indexing", async () => {
    vi.useFakeTimers();
    const { d } = fixture();
    d.startBoundedCleanupLoop();
    let release!: () => void;
    const bulk = d.operations.runShared(
      "index-project",
      undefined,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    d.lastCleanupAttempt = Date.now();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prepareBoundedMaintenanceRuntime).not.toHaveBeenCalled();
    expect(d.operations.status).toBe("open");
    release();
    await bulk;
    clearInterval(d.boundedCleanupInterval);
  });

  it.each(["add-project", "ensure-project", "index-project", "index-pending"])(
    "defers active %s before runtime/watcher/read admission",
    async (name) => {
      const { daemon, d } = fixture();
      let release!: () => void;
      const bulk = d.operations.runShared(
        name,
        undefined,
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      await expect(daemon.runBoundedMaintenance()).resolves.toMatchObject({
        status: "skipped",
        reason: expect.stringContaining("indexing is active"),
      });
      expect(prepareBoundedMaintenanceRuntime).not.toHaveBeenCalled();
      expect(d.watcherManager.quiesceAll).not.toHaveBeenCalled();
      expect(daemon.operationStatus()).toBe("open");
      release();
      await bulk;
    },
  );

  it("rechecks indexing after runtime preparation yields", async () => {
    const { daemon, d } = fixture();
    let prepared!: (runtime: { executable: string }) => void;
    vi.mocked(prepareBoundedMaintenanceRuntime).mockImplementationOnce(
      () => new Promise((resolve) => (prepared = resolve)),
    );
    const cleanup = daemon.runBoundedMaintenance();
    let release!: () => void;
    const bulk = d.operations.runShared(
      "index-project",
      undefined,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    prepared({ executable: "fixture" });
    await expect(cleanup).resolves.toMatchObject({ status: "skipped" });
    expect(d.watcherManager.quiesceAll).not.toHaveBeenCalled();
    release();
    await bulk;
  });

  it("keeps searches available while watcher writes quiesce, then restores catchup", async () => {
    const { daemon, d } = fixture();
    let releaseQuiesce!: () => void;
    d.watcherManager.quiesceAll.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseQuiesce = resolve)),
    );
    const cleanup = daemon.runBoundedMaintenance();
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      d.operations.runShared("search", undefined, async () => "before tag"),
    ).resolves.toBe("before tag");
    d.vectorDb.cleanupDeletedRows.mockImplementationOnce(
      async (_runtime: unknown, readers: any) => {
        readers.open({
          beforeVersion: 7,
          readerTag: "gmax-before-1",
          receiptId: "attempt-1",
        });
        await expect(
          d.operations.runShared(
            "search",
            undefined,
            async () => "tag protected",
          ),
        ).resolves.toBe("tag protected");
        await readers.drain();
        return completed;
      },
    );
    releaseQuiesce();
    await expect(cleanup).resolves.toEqual(completed);
    expect(d.watcherManager.resumeAll).toHaveBeenCalledWith(["/fixture"], {
      catchup: false,
    });
    expect(d.watcherManager.catchupAll).toHaveBeenCalledWith(["/fixture"]);
    expect(daemon.operationStatus()).toBe("open");
  });

  it("coalesces concurrent requests and restores watchers after uncertainty", async () => {
    const { daemon, d } = fixture();
    d.vectorDb.cleanupDeletedRows.mockRejectedValueOnce(
      new Error("native attempt uncertain"),
    );
    const first = daemon.runBoundedMaintenance();
    const second = daemon.runBoundedMaintenance();
    expect(first).toBe(second);
    await expect(first).rejects.toThrow("uncertain");
    expect(d.vectorDb.cleanupDeletedRows).toHaveBeenCalledOnce();
    expect(d.watcherManager.resumeAll).toHaveBeenCalledOnce();
    expect(daemon.operationStatus()).toBe("open");
  });
});
