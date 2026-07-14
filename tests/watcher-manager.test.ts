import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/watcher-store", () => ({
  registerWatcher: vi.fn(),
  unregisterWatcherByRoot: vi.fn(),
}));

vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: vi.fn(),
  registerProject: vi.fn(),
}));

import { WatcherManager } from "../src/lib/daemon/watcher-manager";
import { registerWatcher } from "../src/lib/utils/watcher-store";

describe("WatcherManager.unwatchProject", () => {
  afterEach(() => vi.restoreAllMocks());

  function deps() {
    return {
      processors: new Map(),
      subscriptions: new Map(),
      evictSearcher: vi.fn(),
    } as any;
  }

  it("stops poll-mode timers and the FSEvents recovery probe for the root", async () => {
    // Empty processors map → unwatchProject early-returns after timer cleanup,
    // which is exactly the path we're exercising. Other deps go unused here.
    const wm = new WatcherManager(deps());
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const poll = setInterval(() => {}, 1_000_000);
    const recovery = setInterval(() => {}, 1_000_000);
    const lifecycle = new AbortController();
    (wm as any).pollIntervals.set("/p/app", poll);
    (wm as any).pollRecoveryTimers.set("/p/app", recovery);
    (wm as any).watchLifecycles.set("/p/app", lifecycle);

    await wm.unwatchProject("/p/app");

    expect((wm as any).pollIntervals.has("/p/app")).toBe(false);
    expect((wm as any).pollRecoveryTimers.has("/p/app")).toBe(false);
    expect(clearSpy).toHaveBeenCalledWith(poll);
    expect(clearSpy).toHaveBeenCalledWith(recovery);
    expect(lifecycle.signal.aborted).toBe(true);
  });

  it("leaves another project's poll timers untouched", async () => {
    const wm = new WatcherManager(deps());
    const other = setInterval(() => {}, 1_000_000);
    (wm as any).pollIntervals.set("/p/other", other);

    await wm.unwatchProject("/p/app");

    expect((wm as any).pollIntervals.has("/p/other")).toBe(true);
    clearInterval(other);
  });

  it("cancels a delayed recovery before closing the old processor", async () => {
    const root = "/p/app";
    const processor = { close: vi.fn(async () => {}) };
    const dependencies = deps();
    dependencies.processors.set(root, processor);
    const wm = new WatcherManager(dependencies);
    const timeout = setTimeout(() => {}, 1_000_000);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    (wm as any).recoveryTimeouts.set(root, timeout);
    (wm as any).pendingOps.add(`recover:${root}`);

    await wm.unwatchProject(root);

    expect(clearSpy).toHaveBeenCalledWith(timeout);
    expect((wm as any).pendingOps.has(`recover:${root}`)).toBe(false);
    expect(dependencies.processors.has(root)).toBe(false);
    expect(processor.close).toHaveBeenCalledOnce();
  });

  it("does not resurrect a watcher generation aborted during subscribe", async () => {
    const root = "/p/app";
    let finishSubscribe!: () => void;
    const subscribe = new Promise<void>((resolve) => {
      finishSubscribe = resolve;
    });
    const dependencies = {
      ...deps(),
      getVectorDb: () => ({ diskPressure: "ok" }),
      getMetaCache: () => ({ get: vi.fn() }),
      getShuttingDown: () => false,
      touchActivity: vi.fn(),
    } as any;
    const wm = new WatcherManager(dependencies);
    vi.spyOn(wm as any, "subscribeWatcher").mockReturnValue(subscribe);
    vi.spyOn(wm as any, "runCatchup").mockResolvedValue(true);

    const watching = wm.watchProject(root);
    await vi.waitFor(() =>
      expect(dependencies.processors.has(root)).toBe(true),
    );
    await wm.unwatchProject(root);
    finishSubscribe();
    await watching;

    expect(dependencies.processors.has(root)).toBe(false);
    expect((wm as any).watchLifecycles.has(root)).toBe(false);
  });

  it("keeps daemon watcher health degraded until a capped path succeeds", async () => {
    const root = "/p/app";
    const dependencies = {
      ...deps(),
      getVectorDb: () => ({ diskPressure: "ok" }),
      getMetaCache: () => ({ get: vi.fn() }),
      getShuttingDown: () => false,
      touchActivity: vi.fn(),
    } as any;
    const wm = new WatcherManager(dependencies);
    vi.spyOn(wm as any, "subscribeWatcher").mockResolvedValue(undefined);
    vi.spyOn(wm as any, "runCatchup").mockResolvedValue(true);

    await wm.watchProject(root);
    const processor = dependencies.processors.get(root) as any;
    processor.onTerminalFailure("/p/app/source.ts");
    expect((wm as any).isRootDegraded(root)).toBe(true);

    processor.onPathSuccess("/p/app/source.ts");
    expect((wm as any).isRootDegraded(root)).toBe(false);
    await wm.unwatchProject(root);
  });

  it("returns to watching after a settled zero-reindex batch", async () => {
    const root = "/p/app";
    const dependencies = {
      ...deps(),
      getVectorDb: () => ({
        diskPressure: "ok",
        checkDiskPressure: () => "ok",
        deletePaths: vi.fn(async () => {}),
        compactIfNeeded: vi.fn(async () => {}),
      }),
      getMetaCache: () => ({ get: vi.fn() }),
      getShuttingDown: () => false,
      touchActivity: vi.fn(),
    } as any;
    const wm = new WatcherManager(dependencies);
    vi.spyOn(wm as any, "subscribeWatcher").mockResolvedValue(undefined);
    vi.spyOn(wm as any, "runCatchup").mockResolvedValue(true);
    await wm.watchProject(root, { catchup: false });
    const processor = dependencies.processors.get(root) as any;
    const register = vi.mocked(registerWatcher);
    register.mockClear();

    processor.handleFileEvent("change", "/p/app/missing.ts");
    expect(register).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "syncing" }),
    );

    processor.startBatch();
    await processor.activeBatch;

    expect(register).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "watching" }),
    );

    processor.onReindex(1, 5);
    processor.onBatchSettled();
    expect(register).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "watching",
        lastReindex: expect.any(Number),
      }),
    );
    await wm.unwatchProject(root);
  });

  it("quiesces every processor and returns a resumable root snapshot", async () => {
    const dependencies = deps();
    const first = { close: vi.fn(async () => {}) };
    const second = { close: vi.fn(async () => {}) };
    dependencies.processors.set("/p/first", first);
    dependencies.processors.set("/p/second", second);
    const wm = new WatcherManager(dependencies);

    const roots = await wm.quiesceAll();

    expect(new Set(roots)).toEqual(new Set(["/p/first", "/p/second"]));
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(dependencies.processors.size).toBe(0);
  });
});
