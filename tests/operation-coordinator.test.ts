import { describe, expect, it, vi } from "vitest";
import {
  OperationBusyError,
  OperationClosedError,
  OperationCoordinator,
} from "../src/lib/utils/operation-coordinator";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("OperationCoordinator", () => {
  it("admits current reads during prune-only deletion while keeping writes queued", async () => {
    const coordinator = new OperationCoordinator();
    const entered = deferred();
    const release = deferred();
    const cleanup = coordinator.runExclusive(
      "version-cleanup",
      async () => {},
      async () => {
        coordinator.openVersionCleanupReadWindow((name) => name === "search");
        entered.resolve();
        await release.promise;
      },
      { queueShared: true },
    );
    await entered.promise;
    await expect(
      coordinator.runShared("search", undefined, async () => "current rows"),
    ).resolves.toBe("current rows");
    const write = vi.fn(async () => {});
    const queued = coordinator.runShared("write", undefined, write);
    expect(write).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([cleanup, queued]);
    expect(write).toHaveBeenCalledOnce();
  });

  it("cannot enable a retention read window for a rewrite or before reader drain", async () => {
    const coordinator = new OperationCoordinator();
    expect(() => coordinator.openVersionCleanupReadWindow(() => true)).toThrow(
      "prune-only",
    );
    await coordinator.runExclusive(
      "repair",
      async () => {},
      async () => {
        expect(() =>
          coordinator.openVersionCleanupReadWindow(() => true),
        ).toThrow("prune-only");
      },
      { queueShared: true },
    );
  });
  it("waits for automatic cleanup before admitting searches without a busy failure", async () => {
    const coordinator = new OperationCoordinator();
    const release = deferred();
    const cleanup = coordinator.runExclusive(
      "version-cleanup",
      async () => {},
      async () => release.promise,
      { queueShared: true },
    );
    const search = vi.fn(async () => "found");
    const pending = coordinator.runShared("search", undefined, search);
    expect(search).not.toHaveBeenCalled();
    await expect(
      coordinator.runShared("watch-batch", undefined, async () => {}),
    ).rejects.toBeInstanceOf(OperationBusyError);
    release.resolve();
    await cleanup;
    await expect(pending).resolves.toBe("found");
  });

  it("cancels queued searches and never includes them in the drain it awaits", async () => {
    const coordinator = new OperationCoordinator();
    const release = deferred();
    const cleanup = coordinator.runExclusive(
      "version-cleanup",
      async () => {},
      async () => release.promise,
      { queueShared: true },
    );
    const controller = new AbortController();
    const search = vi.fn(async () => {});
    const pending = coordinator.runShared("search", controller.signal, search);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    release.resolve();
    await cleanup;
    expect(search).not.toHaveBeenCalled();
  });

  it("shutdown rejects queued work instead of running it after cleanup", async () => {
    const coordinator = new OperationCoordinator();
    const release = deferred();
    const cleanup = coordinator.runExclusive(
      "version-cleanup",
      async () => {},
      async () => release.promise,
      { queueShared: true },
    );
    await Promise.resolve();
    await Promise.resolve();
    const search = vi.fn(async () => {});
    const pending = coordinator.runShared("search", undefined, search);
    const rejected =
      expect(pending).rejects.toBeInstanceOf(OperationClosedError);
    const close = coordinator.close();
    await rejected;
    release.resolve();
    await Promise.allSettled([cleanup, close]);
    expect(search).not.toHaveBeenCalled();
  });

  it("allows shared operations to overlap", async () => {
    const coordinator = new OperationCoordinator();
    const release = deferred();
    let active = 0;
    let peak = 0;
    const run = () =>
      coordinator.runShared("search", undefined, async () => {
        active++;
        peak = Math.max(peak, active);
        await release.promise;
        active--;
      });

    const first = run();
    const second = run();
    await vi.waitFor(() => expect(peak).toBe(2));
    release.resolve();
    await Promise.all([first, second]);
  });

  it("blocks new shared admission as soon as exclusive intent exists", async () => {
    const coordinator = new OperationCoordinator();
    const sharedRelease = deferred();
    const quiesced = deferred();
    const shared = coordinator.runShared("search", undefined, async () => {
      await sharedRelease.promise;
    });
    const exclusive = coordinator.runExclusive(
      "repair",
      async () => {
        quiesced.resolve();
      },
      async () => {},
    );
    await quiesced.promise;

    await expect(
      coordinator.runShared("search", undefined, async () => {}),
    ).rejects.toBeInstanceOf(OperationBusyError);
    sharedRelease.resolve();
    await Promise.all([shared, exclusive]);
  });

  it("quiesces before waiting for admitted shared work to drain", async () => {
    const coordinator = new OperationCoordinator();
    const sharedRelease = deferred();
    const events: string[] = [];
    const shared = coordinator.runShared("search", undefined, async () => {
      events.push("shared:start");
      await sharedRelease.promise;
      events.push("shared:end");
    });
    const exclusive = coordinator.runExclusive(
      "repair",
      async () => {
        events.push("quiesce");
      },
      async () => {
        events.push("exclusive");
      },
    );
    await vi.waitFor(() => expect(events).toContain("quiesce"));
    expect(events).toEqual(["shared:start", "quiesce"]);
    sharedRelease.resolve();
    await Promise.all([shared, exclusive]);
    expect(events).toEqual([
      "shared:start",
      "quiesce",
      "shared:end",
      "exclusive",
    ]);
  });

  it("admits only one exclusive request", async () => {
    const coordinator = new OperationCoordinator();
    const release = deferred();
    const first = coordinator.runExclusive(
      "repair",
      async () => {},
      async () => release.promise,
    );

    await expect(
      coordinator.runExclusive(
        "other",
        async () => {},
        async () => {},
      ),
    ).rejects.toBeInstanceOf(OperationBusyError);
    release.resolve();
    await first;
  });

  it("close aborts active work, rejects new work, and is single-flight", async () => {
    const coordinator = new OperationCoordinator();
    const observedAbort = deferred();
    const active = coordinator.runShared(
      "search",
      undefined,
      async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort.resolve();
              resolve();
            },
            { once: true },
          );
        });
      },
    );

    const firstClose = coordinator.close();
    const secondClose = coordinator.close();
    expect(firstClose).toBe(secondClose);
    await observedAbort.promise;
    await Promise.all([active, firstClose]);
    await expect(
      coordinator.runShared("search", undefined, async () => {}),
    ).rejects.toBeInstanceOf(OperationClosedError);
  });
});

describe("OperationCoordinator diagnostics", () => {
  it("names admitted operations until they settle", async () => {
    const coordinator = new OperationCoordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = coordinator.runShared("remove-project", undefined, () => gate);
    expect(coordinator.activeOperationNames()).toEqual(["remove-project"]);
    release();
    await task;
    expect(coordinator.activeOperationNames()).toEqual([]);
  });
});
