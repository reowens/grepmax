import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/watcher-store", () => ({
  unregisterWatcherByRoot: vi.fn(),
}));

import { Daemon } from "../src/lib/daemon/daemon";

describe("live work during a daemon catchup", () => {
  afterEach(() => vi.restoreAllMocks());

  function fixture() {
    const daemon = new Daemon() as any;
    // Exercise the real project mutex and lifecycle coordinator, without
    // probing the user's host or starting workers/native stores.
    vi.spyOn(daemon, "assertHeavyOperationAdmission").mockImplementation(
      () => {},
    );
    const manager = daemon.watcherManager as any;
    const root = "/test/catchup-priority";
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const scan = vi
      .spyOn(manager, "catchupScan")
      .mockImplementation(async (_root, _processor, signal: AbortSignal) => {
        began();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return false;
      });
    const catchup = manager.runCatchup(root, {});
    const cleanup = async () => {
      manager.catchups.get(root)?.controller.abort();
      await catchup;
      await daemon.operations.close();
      await daemon.projectMutex.close();
    };
    return { daemon, manager, root, started, scan, catchup, cleanup };
  }

  it("starts a live batch before the reconciliation scan finishes", async () => {
    const f = fixture();
    let batch: Promise<unknown> | undefined;
    try {
      await f.started;
      const apply = vi.fn(async () => "live edit applied");
      batch = f.manager.deps.runProjectOperation(
        f.root,
        "watch-batch",
        undefined,
        apply,
      );
      await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce(), {
        timeout: 250,
      });
      expect(await batch).toBe("live edit applied");
      expect(f.manager.health(f.root).catchupRunning).toBe(true);
      expect(f.daemon.operations.activeCount).toBe(1);
    } finally {
      await f.cleanup();
      await batch;
    }
  });

  it("lets an exclusive project change quiesce the running scan", async () => {
    const f = fixture();
    let unwatch: Promise<unknown> | undefined;
    try {
      await f.started;
      unwatch = f.daemon.withProjectLock(f.root, undefined, () =>
        f.manager.unwatchProject(f.root),
      );
      await vi.waitFor(
        () => expect(f.manager.health(f.root).catchupRunning).toBe(false),
        { timeout: 250 },
      );
      await unwatch;
      expect(f.scan.mock.calls[0][2].aborted).toBe(true);
    } finally {
      await f.cleanup();
      await unwatch;
    }
  });

  it("still tracks and drains catchup before lifecycle closure", async () => {
    const f = fixture();
    try {
      await f.started;
      expect(f.daemon.operations.activeOperationNames()).toContain(
        "watch-catchup",
      );
      await f.daemon.operations.close();
      await f.catchup;
      expect(f.scan.mock.calls[0][2].aborted).toBe(true);
      expect(f.manager.health(f.root).catchupRunning).toBe(false);
      expect(f.daemon.operations.activeCount).toBe(0);
      await expect(
        f.manager.deps.runProjectOperation(
          f.root,
          "watch-batch",
          undefined,
          async () => {},
        ),
      ).rejects.toThrow("closing");
    } finally {
      await f.cleanup();
    }
  });
});
