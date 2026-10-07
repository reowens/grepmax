import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AsyncSubscription, SubscribeCallback } from "@parcel/watcher";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@parcel/watcher", () => ({ subscribe: vi.fn() }));

vi.mock("../src/lib/utils/watcher-store", () => ({
  registerWatcher: vi.fn(),
  unregisterWatcherByRoot: vi.fn(),
}));

vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: vi.fn(),
  registerProject: vi.fn(),
}));

import { WatcherManager } from "../src/lib/daemon/watcher-manager";
import { ProjectBatchProcessor } from "../src/lib/index/batch-processor";
import { registerWatcher } from "../src/lib/utils/watcher-store";

describe("WatcherManager.unwatchProject", () => {
  afterEach(() => vi.restoreAllMocks());

  function deps() {
    return {
      processors: new Map(),
      subscriptions: new Map(),
      evictSearcher: vi.fn(),
      touchActivity: vi.fn(),
      getShuttingDown: () => false,
    } as any;
  }

  it("tags reconciliation changes and retirements as background work", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "gmax-catchup-queue-"),
    );
    const source = path.join(root, "source.ts");
    const removed = path.join(root, "removed.json");
    await fs.writeFile(source, "export const source = 1;\n");
    const metaCache = {
      getKeysWithPrefix: vi.fn(async () => new Set([removed])),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const vectorDb = {
      getDistinctPathsForPrefix: vi.fn(async () => new Set([removed])),
    };
    const dependencies = {
      ...deps(),
      getMetaCache: () => metaCache,
      getVectorDb: () => vectorDb,
    } as any;
    const processor = new ProjectBatchProcessor({
      projectRoot: root,
      metaCache: metaCache as any,
      vectorDb: vectorDb as any,
    });
    dependencies.processors.set(root, processor);
    const wm = new WatcherManager(dependencies) as any;
    try {
      await wm.catchupScan(root, processor, new AbortController().signal);
      expect(processor.progress.queue).toMatchObject({
        live: 0,
        catchup: 1,
        cleanup: 1,
        oldestLiveEditAgeMs: null,
      });
    } finally {
      await wm.unwatchProject(root);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes native exclusions on policy edits, including re-inclusions and deletion", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "gmax-manager-ignore-"),
    );
    const policy = path.join(root, ".gmaxignore");
    const watcher = await import("@parcel/watcher");
    let notify!: SubscribeCallback;
    const unsubscribe = vi.fn(async () => {});
    vi.mocked(watcher.subscribe)
      .mockClear()
      .mockImplementation(async (_root, callback) => {
        notify = callback;
        return { unsubscribe };
      });
    const dependencies = {
      ...deps(),
      getVectorDb: () => ({ diskPressure: "ok" }),
      getMetaCache: () => ({ get: vi.fn() }),
      getShuttingDown: () => false,
      touchActivity: vi.fn(),
    } as any;
    const wm = new WatcherManager(dependencies);
    const catchup = vi
      .spyOn(wm as any, "runCatchup")
      .mockResolvedValue(undefined);
    try {
      await fs.writeFile(policy, "/artifacts/**/*.json\n");
      await wm.watchProject(root, { catchup: false });
      expect(vi.mocked(watcher.subscribe).mock.calls[0][2]?.ignore).toContain(
        "artifacts/**/*.json",
      );
      await fs.writeFile(
        policy,
        "/artifacts/**/*.json\n!artifacts/source.json\n",
      );
      notify(null, [{ type: "update", path: policy }]);
      await vi.waitFor(() => expect(catchup).toHaveBeenCalledTimes(1));
      expect(
        vi.mocked(watcher.subscribe).mock.calls[1][2]?.ignore,
      ).not.toContain("artifacts/**/*.json");
      expect(unsubscribe).toHaveBeenCalledOnce();
      await fs.unlink(policy);
      notify(null, [{ type: "delete", path: policy }]);
      await vi.waitFor(() => expect(catchup).toHaveBeenCalledTimes(2));
      expect(
        vi.mocked(watcher.subscribe).mock.calls[2][2]?.ignore,
      ).not.toContain("artifacts/**/*.json");
    } finally {
      await wm.unwatchProject(root);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("disposes a subscription that finishes after unwatch begins", async () => {
    const watcher = await import("@parcel/watcher");
    let finish!: (value: AsyncSubscription) => void;
    vi.mocked(watcher.subscribe)
      .mockClear()
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const dependencies = deps();
    const root = "/p/app";
    const processor = { close: vi.fn(async () => {}) };
    dependencies.processors.set(root, processor);
    const wm = new WatcherManager(dependencies) as any;
    const subscribing = wm.subscribeWatcher(root, processor);
    await vi.waitFor(() => expect(watcher.subscribe).toHaveBeenCalledOnce());
    const unwatching = wm.unwatchProject(root);
    const unsubscribe = vi.fn(async () => {});
    finish({ unsubscribe });
    await Promise.all([subscribing, unwatching]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dependencies.subscriptions.size).toBe(0);
    expect(processor.close).toHaveBeenCalledOnce();
  });

  it("counts every watcher drop and recovers while throttling repeated error logs", async () => {
    const watcher = await import("@parcel/watcher");
    let notify!: (error: Error, events: []) => void;
    vi.mocked(watcher.subscribe).mockImplementation(async (_root, callback) => {
      notify = callback;
      return { unsubscribe: async () => {} };
    });
    const d = deps();
    const root = "/p/app";
    const processor = {};
    d.processors.set(root, processor);
    const wm = new WatcherManager(d) as any;
    const recover = vi.spyOn(wm, "recoverWatcher").mockImplementation(() => {});
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    await wm.subscribeWatcher(root, processor);
    for (let i = 0; i < 5; i++) notify(new Error("Events were dropped"), []);
    expect(wm.health(root).overflowCount).toBe(5);
    expect(logs).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledTimes(5);
    now.mockReturnValue(61_000);
    notify(new Error("Events were dropped"), []);
    expect(wm.health(root).overflowCount).toBe(6);
    expect(logs).toHaveBeenCalledTimes(2);
  });

  it.each([
    "Events were dropped by the FSEvents client. File system must be re-scanned.",
    "Events were dropped by the kernel. File system must be re-scanned.",
    "Too many events. File system must be re-scanned.",
  ])(
    "keeps native edits and reconciles a continuing FSEvents stream: %s",
    async (message) => {
      const watcher = await import("@parcel/watcher");
      let notify!: SubscribeCallback;
      const unsubscribe = vi.fn(async () => {});
      vi.mocked(watcher.subscribe).mockClear();
      vi.mocked(watcher.subscribe).mockImplementation(
        async (_root, callback) => {
          notify = callback;
          return { unsubscribe };
        },
      );
      const d = deps();
      const root = "/p/app";
      const processor = {
        handleFileEvent: vi.fn(),
        close: vi.fn(async () => {}),
      };
      d.processors.set(root, processor);
      const wm = new WatcherManager(d) as any;
      const recover = vi.spyOn(wm, "recoverWatcher");
      const scan = vi.spyOn(wm, "runCatchup").mockResolvedValue(undefined);
      vi.spyOn(console, "error").mockImplementation(() => {});
      await wm.subscribeWatcher(root, processor);
      notify(new Error(message), [
        { type: "update", path: `${root}/saved.ts` },
      ]);
      notify(null, [{ type: "delete", path: `${root}/removed.ts` }]);
      expect(processor.handleFileEvent.mock.calls).toEqual([
        ["change", `${root}/saved.ts`],
        ["unlink", `${root}/removed.ts`],
      ]);
      expect(scan).toHaveBeenCalledOnce();
      expect(recover).not.toHaveBeenCalled();
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(watcher.subscribe).toHaveBeenCalledOnce();
      expect(wm.health(root)).toMatchObject({
        overflowCount: 1,
        watcherMode: "recovering",
      });
      await wm.unwatchProject(root);
    },
  );

  it("coalesces gaps during a scan and cancels the follow-up on unwatch", async () => {
    vi.useFakeTimers();
    try {
      const watcher = await import("@parcel/watcher");
      let notify!: SubscribeCallback;
      vi.mocked(watcher.subscribe).mockClear();
      vi.mocked(watcher.subscribe).mockImplementation(
        async (_root, callback) => {
          notify = callback;
          return { unsubscribe: vi.fn(async () => {}) };
        },
      );
      const d = deps();
      const root = "/p/app";
      const processor = {
        handleFileEvent: vi.fn(),
        close: vi.fn(async () => {}),
      };
      d.processors.set(root, processor);
      const wm = new WatcherManager(d) as any;
      const scan = vi.spyOn(wm, "catchupScan").mockImplementation(async () => {
        (wm as any).overflowPendingRoots.delete(root);
        return true;
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      await wm.subscribeWatcher(root, processor);
      const gap = new Error(
        "Events were dropped by the FSEvents client. File system must be re-scanned.",
      );
      notify(gap, []);
      await Promise.resolve();
      await Promise.resolve();
      for (let i = 0; i < 50; i++) notify(gap, []);
      expect(scan).toHaveBeenCalledOnce();
      expect(wm.deferredCatchups.size).toBe(1);
      expect(wm.health(root).overflowCount).toBe(51);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(scan).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(scan).toHaveBeenCalledTimes(2);
      expect(wm.health(root).watcherMode).toBe("native");
      notify(gap, []);
      await wm.unwatchProject(root);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scan).toHaveBeenCalledTimes(2);
      expect(watcher.subscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a gap arriving during reconciliation visible until a later complete scan", async () => {
    const watcher = await import("@parcel/watcher");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gmax-gap-scan-"));
    let notify!: SubscribeCallback;
    vi.mocked(watcher.subscribe).mockImplementation(async (_root, callback) => {
      notify = callback;
      return { unsubscribe: vi.fn(async () => {}) };
    });
    const metaCache = {
      getKeysWithPrefix: vi.fn(async () => new Set<string>()),
      get: vi.fn(),
      put: vi.fn(),
    };
    const vectorDb = {
      getDistinctPathsForPrefix: vi.fn(async () => new Set<string>()),
    };
    const d = {
      ...deps(),
      getMetaCache: () => metaCache,
      getVectorDb: () => vectorDb,
    };
    const processor = new ProjectBatchProcessor({
      projectRoot: root,
      metaCache: metaCache as any,
      vectorDb: vectorDb as any,
    });
    d.processors.set(root, processor);
    const wm = new WatcherManager(d) as any;
    vi.spyOn(wm, "requestOverflowCatchup").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await wm.subscribeWatcher(root, processor);
      const gap = new Error("Too many events. File system must be re-scanned.");
      notify(gap, []);
      metaCache.getKeysWithPrefix.mockImplementationOnce(async () => {
        notify(gap, []);
        return new Set<string>();
      });
      await wm.catchupScan(root, processor, new AbortController().signal);
      expect(wm.health(root)).toMatchObject({
        overflowCount: 2,
        watcherMode: "recovering",
      });
      await wm.catchupScan(root, processor, new AbortController().signal);
      expect(wm.health(root).watcherMode).toBe("native");
    } finally {
      await wm.unwatchProject(root);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("still retries terminal failures and falls back after repeated failed streams", async () => {
    vi.useFakeTimers();
    try {
      const watcher = await import("@parcel/watcher");
      let notify!: SubscribeCallback;
      const unsubscribe = vi.fn(async () => {});
      vi.mocked(watcher.subscribe).mockClear();
      vi.mocked(watcher.subscribe).mockImplementation(
        async (_root, callback) => {
          notify = callback;
          return { unsubscribe };
        },
      );
      const d = deps();
      const root = "/p/app";
      const processor = {
        handleFileEvent: vi.fn(),
        close: vi.fn(async () => {}),
      };
      d.processors.set(root, processor);
      const wm = new WatcherManager(d) as any;
      vi.spyOn(wm, "runCatchup").mockResolvedValue(undefined);
      vi.spyOn(console, "error").mockImplementation(() => {});
      await wm.subscribeWatcher(root, processor);
      for (const delay of [3000, 6000, 12000]) {
        notify(new Error("backend stopped"), []);
        await vi.advanceTimersByTimeAsync(delay);
        // Native policy reads use real filesystem I/O even under fake timers.
        // Wait for the new callback to attach before failing that generation.
        await vi.waitFor(() =>
          expect(wm.pendingOps.has(`recover:${root}`)).toBe(false),
        );
      }
      notify(new Error("backend stopped"), []);
      expect(wm.health(root)).toMatchObject({
        watcherMode: "polling",
        overflowCount: 4,
      });
      expect(unsubscribe).toHaveBeenCalledTimes(4);
      expect(watcher.subscribe).toHaveBeenCalledTimes(4);
      await wm.unwatchProject(root);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores errors and events from an obsolete subscription generation", async () => {
    const watcher = await import("@parcel/watcher");
    const callbacks: SubscribeCallback[] = [];
    vi.mocked(watcher.subscribe).mockImplementation(async (_root, callback) => {
      callbacks.push(callback);
      return { unsubscribe: vi.fn(async () => {}) };
    });
    const d = deps();
    const root = "/p/app";
    const processor = {
      handleFileEvent: vi.fn(),
      close: vi.fn(async () => {}),
    };
    d.processors.set(root, processor);
    const wm = new WatcherManager(d) as any;
    const recover = vi.spyOn(wm, "recoverWatcher");
    await wm.subscribeWatcher(root, processor);
    await wm.subscribeWatcher(root, processor);
    callbacks[0](new Error("backend stopped"), [
      { type: "update", path: `${root}/old.ts` },
    ]);
    callbacks[1](null, [{ type: "update", path: `${root}/new.ts` }]);
    expect(recover).not.toHaveBeenCalled();
    expect(wm.health(root).overflowCount).toBe(0);
    expect(processor.handleFileEvent).toHaveBeenCalledExactlyOnceWith(
      "change",
      `${root}/new.ts`,
    );
    await wm.unwatchProject(root);
  });

  it("reports polling, recovery, failures, and successful reconciliation independently", async () => {
    const wm = new WatcherManager(deps());
    const root = "/p/app";
    const poll = setInterval(() => {}, 1_000_000);
    (wm as any).pollIntervals.set(root, poll);
    (wm as any).terminalFailures.set(root, new Set(["/p/app/a.ts"]));
    (wm as any).reconciledAt.set(root, 123);
    (wm as any).catchupDurations.set(root, 45);
    (wm as any).overflowCounts.set(root, 8);
    expect(wm.health(root)).toMatchObject({
      watcherMode: "polling",
      failedFiles: 1,
      degraded: true,
      lastReconciledAt: 123,
      catchupMs: 45,
      overflowCount: 8,
    });
    await wm.unwatchProject(root);
  });
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

  it("coalesces overflow recoveries inside the cooldown into one catchup", async () => {
    vi.useFakeTimers();
    try {
      const processor = {} as any;
      const d = deps();
      d.processors.set("/p/app", processor);
      d.getShuttingDown = () => false;
      const wm = new WatcherManager(d);
      const runCatchup = vi.fn(async () => {});
      (wm as any).runCatchup = runCatchup;

      expect((wm as any).deferCatchup("/p/app", processor, 1000)).toBe(true);
      expect((wm as any).deferCatchup("/p/app", processor, 1000)).toBe(false);
      expect((wm as any).deferCatchup("/p/app", processor, 1000)).toBe(false);

      await vi.advanceTimersByTimeAsync(999);
      expect(runCatchup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runCatchup).toHaveBeenCalledTimes(1);
      expect((wm as any).deferredCatchups.has("/p/app")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a deferred catchup when the project is unwatched", async () => {
    vi.useFakeTimers();
    try {
      const wm = new WatcherManager(deps());
      const runCatchup = vi.fn(async () => {});
      (wm as any).runCatchup = runCatchup;
      (wm as any).deferCatchup("/p/app", {} as any, 1000);

      await wm.unwatchProject("/p/app");
      await vi.advanceTimersByTimeAsync(2000);

      expect((wm as any).deferredCatchups.has("/p/app")).toBe(false);
      expect(runCatchup).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
