import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/lib/daemon/daemon";
import { prepareVersionCleanup } from "../src/lib/store/version-cleanup";

vi.mock("../src/lib/store/version-cleanup", async (original) => ({
  ...(await original<typeof import("../src/lib/store/version-cleanup")>()),
  prepareVersionCleanup: vi.fn(async () => ({
    python: "fixture",
    script: "prune.py",
  })),
}));
const completed = {
  status: "completed" as const,
  at: 1,
  attempts: 1,
  elapsedMs: 1,
  eligibleVersionsRemaining: 0,
};
describe("daemon automatic version cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
  function fixture() {
    const daemon = new Daemon();
    const d = daemon as any;
    d.ready = true;
    d.vectorDb = {
      cleanupVersions: vi.fn(async () => completed),
      versionCleanupStatus: () => completed,
    };
    d.processors.set("/fixture", {});
    const watcherManager = {
      isPaused: false,
      pauseAll: vi.fn(async () => {
        watcherManager.isPaused = true;
        return ["/fixture"];
      }),
      resumePaused: vi.fn(() => {
        watcherManager.isPaused = false;
      }),
      quiesceAll: vi.fn(async () => {
        watcherManager.isPaused = false;
        return ["/fixture"];
      }),
    };
    d.watcherManager = watcherManager;
    vi.spyOn(d, "assertHeavyOperationAdmission").mockImplementation(() => {});
    return { daemon, d };
  }
  it.each([
    "add-project",
    "ensure-project",
    "index-project",
    "index-pending",
    "fts-build",
  ])("defers behind %s without closing reads or watchers", async (name) => {
    const { daemon, d } = fixture();
    let release!: () => void;
    const bulk = d.operations.runShared(
      name,
      undefined,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await expect(daemon.runVersionCleanup()).resolves.toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("indexing is active"),
    });
    expect(prepareVersionCleanup).not.toHaveBeenCalled();
    expect(d.watcherManager.pauseAll).not.toHaveBeenCalled();
    await expect(
      d.operations.runShared("search", undefined, async () => "found"),
    ).resolves.toBe("found");
    expect(daemon.operationStatus()).toBe("open");
    release();
    await bulk;
    await daemon.runVersionCleanup();
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledOnce();
  });
  it("rechecks bulk admission after runtime preparation yields", async () => {
    const { daemon, d } = fixture();
    let prepared!: (runtime: { python: string; script: string }) => void;
    vi.mocked(prepareVersionCleanup).mockImplementationOnce(
      () => new Promise((resolve) => (prepared = resolve)),
    );
    const cleanup = daemon.runVersionCleanup();
    let release!: () => void;
    const bulk = d.operations.runShared(
      "index-project",
      undefined,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    prepared({ python: "fixture", script: "prune.py" });
    await expect(cleanup).resolves.toMatchObject({ status: "skipped" });
    expect(d.watcherManager.pauseAll).not.toHaveBeenCalled();
    expect(daemon.operationStatus()).toBe("open");
    release();
    await bulk;
  });
  it("retries deferred cleanup after one minute when bulk indexing finishes", async () => {
    vi.useFakeTimers();
    const { d } = fixture();
    let release!: () => void;
    const bulk = d.operations.runShared(
      "index-project",
      undefined,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    d.startVersionCleanupLoop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.vectorDb.cleanupVersions).not.toHaveBeenCalled();
    release();
    await bulk;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledOnce();
    clearInterval(d.cleanupInterval);
  });
  it("runs despite continuous activity and status polling, then resumes watched edits without detaching", async () => {
    vi.useFakeTimers();
    const { daemon, d } = fixture();
    d.startVersionCleanupLoop();
    for (let i = 0; i < 12; i++) {
      daemon.resetActivity();
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledOnce();
    expect(prepareVersionCleanup).toHaveBeenCalledOnce();
    expect(d.watcherManager.pauseAll).toHaveBeenCalledOnce();
    expect(d.watcherManager.resumePaused).toHaveBeenCalledOnce();
    expect(d.watcherManager.quiesceAll).not.toHaveBeenCalled();
    expect(daemon.operationStatus()).toBe("open");
    clearInterval(d.cleanupInterval);
  });
  it("restores watchers and open admission after a failed prune", async () => {
    const { daemon, d } = fixture();
    d.vectorDb.cleanupVersions.mockRejectedValue(new Error("prune failed"));
    await expect(daemon.runVersionCleanup()).rejects.toThrow("prune failed");
    expect(d.watcherManager.resumePaused).toHaveBeenCalledOnce();
    expect(d.watcherManager.isPaused).toBe(false);
    expect(daemon.operationStatus()).toBe("open");
  });
  it("detaches paused watchers when the service pauses during cleanup", async () => {
    const { daemon, d } = fixture();
    d.vectorDb.cleanupVersions.mockImplementationOnce(async () => {
      d.pausedReason = "critical pressure";
      return completed;
    });
    await daemon.runVersionCleanup();
    expect(d.watcherManager.resumePaused).not.toHaveBeenCalled();
    expect(d.watcherManager.quiesceAll).toHaveBeenCalledOnce();
    expect(d.watcherManager.isPaused).toBe(false);
  });
  it("does not pause watchers for refused runtime setup", async () => {
    const { daemon, d } = fixture();
    vi.mocked(prepareVersionCleanup).mockRejectedValueOnce(
      new Error("setup refused"),
    );
    await expect(daemon.runVersionCleanup()).rejects.toThrow("setup refused");
    expect(d.watcherManager.pauseAll).not.toHaveBeenCalled();
    expect(daemon.operationStatus()).toBe("open");
  });
  it("coalesces simultaneous manual and periodic requests", async () => {
    const { daemon, d } = fixture();
    const first = daemon.runVersionCleanup();
    const second = daemon.runVersionCleanup();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledOnce();
  });
  it("backs off a failing prune so watched edits are not paused every minute", async () => {
    vi.useFakeTimers();
    const { d } = fixture();
    d.vectorDb.versionCleanupStatus = () => ({
      ...completed,
      eligibleVersionsRemaining: 5,
    });
    d.vectorDb.cleanupVersions.mockRejectedValue(new Error("SIGABRT"));
    d.startVersionCleanupLoop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledTimes(3);
    expect(d.watcherManager.pauseAll).toHaveBeenCalledTimes(3);
    d.vectorDb.cleanupVersions.mockResolvedValue(completed);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledTimes(5);
    clearInterval(d.cleanupInterval);
  });
  it("retries backlog on the next minute and never runs during a paused service", async () => {
    vi.useFakeTimers();
    const { d } = fixture();
    d.vectorDb.versionCleanupStatus = () => ({
      ...completed,
      eligibleVersionsRemaining: 5,
    });
    d.startVersionCleanupLoop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledTimes(2);
    d.pausedReason = "critical pressure";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledTimes(2);
    clearInterval(d.cleanupInterval);
  });
});
