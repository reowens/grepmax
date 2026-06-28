import { afterEach, describe, expect, it, vi } from "vitest";
import { WatcherManager } from "../src/lib/daemon/watcher-manager";

describe("WatcherManager.unwatchProject", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stops poll-mode timers and the FSEvents recovery probe for the root", async () => {
    // Empty processors map → unwatchProject early-returns after timer cleanup,
    // which is exactly the path we're exercising. Other deps go unused here.
    const wm = new WatcherManager({ processors: new Map() } as any);
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const poll = setInterval(() => {}, 1_000_000);
    const recovery = setInterval(() => {}, 1_000_000);
    (wm as any).pollIntervals.set("/p/app", poll);
    (wm as any).pollRecoveryTimers.set("/p/app", recovery);

    await wm.unwatchProject("/p/app");

    expect((wm as any).pollIntervals.has("/p/app")).toBe(false);
    expect((wm as any).pollRecoveryTimers.has("/p/app")).toBe(false);
    expect(clearSpy).toHaveBeenCalledWith(poll);
    expect(clearSpy).toHaveBeenCalledWith(recovery);
  });

  it("leaves another project's poll timers untouched", async () => {
    const wm = new WatcherManager({ processors: new Map() } as any);
    const other = setInterval(() => {}, 1_000_000);
    (wm as any).pollIntervals.set("/p/other", other);

    await wm.unwatchProject("/p/app");

    expect((wm as any).pollIntervals.has("/p/other")).toBe(true);
    clearInterval(other);
  });
});
