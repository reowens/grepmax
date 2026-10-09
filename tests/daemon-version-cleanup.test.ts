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
    d.watcherManager = {
      quiesceAll: vi.fn(async () => ["/fixture"]),
      resumeAll: vi.fn(async () => {}),
      catchupAll: vi.fn(async () => {}),
    };
    vi.spyOn(d, "assertHeavyOperationAdmission").mockImplementation(() => {});
    return { daemon, d };
  }
  it("runs despite continuous activity and status polling, then catches up watched edits", async () => {
    vi.useFakeTimers();
    const { daemon, d } = fixture();
    d.startVersionCleanupLoop();
    for (let i = 0; i < 12; i++) {
      daemon.resetActivity();
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(d.vectorDb.cleanupVersions).toHaveBeenCalledOnce();
    expect(prepareVersionCleanup).toHaveBeenCalledOnce();
    expect(d.watcherManager.resumeAll).toHaveBeenCalledWith(["/fixture"], {
      catchup: false,
    });
    expect(d.watcherManager.catchupAll).toHaveBeenCalledWith(["/fixture"]);
    expect(daemon.operationStatus()).toBe("open");
    clearInterval(d.cleanupInterval);
  });
  it("restores watchers and open admission after a failed prune", async () => {
    const { daemon, d } = fixture();
    d.vectorDb.cleanupVersions.mockRejectedValue(new Error("prune failed"));
    await expect(daemon.runVersionCleanup()).rejects.toThrow("prune failed");
    expect(d.watcherManager.resumeAll).toHaveBeenCalledOnce();
    expect(d.watcherManager.catchupAll).toHaveBeenCalledOnce();
    expect(daemon.operationStatus()).toBe("open");
  });
  it("does not pause watchers for refused runtime setup", async () => {
    const { daemon, d } = fixture();
    vi.mocked(prepareVersionCleanup).mockRejectedValueOnce(
      new Error("setup refused"),
    );
    await expect(daemon.runVersionCleanup()).rejects.toThrow("setup refused");
    expect(d.watcherManager.quiesceAll).not.toHaveBeenCalled();
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
