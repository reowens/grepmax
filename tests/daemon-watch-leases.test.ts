import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/project-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/lib/utils/project-registry")
  >()),
  getProject: vi.fn(() => undefined),
}));

import { Daemon } from "../src/lib/daemon/daemon";
import { handleCommand } from "../src/lib/daemon/ipc-handler";
import { WatchLeases } from "../src/lib/daemon/watch-leases";

describe("Daemon watch leases", () => {
  let daemon: any;
  let watched: Map<string, unknown>;
  let alive: Set<number>;

  beforeEach(() => {
    daemon = new Daemon();
    daemon.ready = true;
    // Keep the real mutex/coordinator without probing the host on watch admission.
    vi.spyOn(daemon, "assertHeavyOperationAdmission").mockImplementation(
      () => {},
    );
    alive = new Set([1]);
    daemon.watchLeases = new WatchLeases(null, {
      isPidAlive: (pid) => alive.has(pid),
    });
    watched = daemon.processors;
    vi.spyOn(daemon.watcherManager, "watchProject").mockImplementation(
      async (root: unknown) => {
        watched.set(root as string, {});
      },
    );
    vi.spyOn(daemon.watcherManager, "unwatchProject").mockImplementation(
      async (root: unknown) => {
        watched.delete(root as string);
      },
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  async function holdProjectLock(root: string) {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = daemon.projectMutex.run(root, undefined, async () => {
      entered();
      await held;
    });
    await started;
    return { release, done };
  }

  function queueLeaseTeardown(trigger: "release" | "sweep") {
    if (trigger === "release") return daemon.releaseWatch("/p", "mcp:1");
    alive.delete(1);
    daemon.sweepWatchLeases();
  }

  it("watches on a lease and unwatches only when the last holder releases", async () => {
    await handleCommand(
      daemon,
      { cmd: "watch", root: "/p", holder: "mcp:1", pid: 1 },
      {} as any,
    );
    await handleCommand(
      daemon,
      { cmd: "watch", root: "/p", holder: "session:s" },
      {} as any,
    );
    expect(watched.has("/p")).toBe(true);

    await handleCommand(
      daemon,
      { cmd: "unwatch", root: "/p", holder: "session:s" },
      {} as any,
    );
    expect(watched.has("/p")).toBe(true);

    await handleCommand(
      daemon,
      { cmd: "unwatch", root: "/p", holder: "mcp:1" },
      {} as any,
    );
    expect(watched.has("/p")).toBe(false);
  });

  it("treats an unwatch without a holder as releasing everyone", async () => {
    await daemon.requestWatch("/p", { holder: "a" });
    await daemon.requestWatch("/p", { holder: "b" });

    await handleCommand(daemon, { cmd: "unwatch", root: "/p" }, {} as any);

    expect(watched.has("/p")).toBe(false);
    expect(daemon.listWatchLeases()).toEqual([]);
  });

  it("unwatches on the heartbeat sweep once a holder process is gone", async () => {
    await daemon.requestWatch("/p", { holder: "mcp:1", pid: 1 });
    expect(watched.has("/p")).toBe(true);

    daemon.sweepWatchLeases();
    expect(watched.has("/p")).toBe(true);

    alive.delete(1);
    daemon.sweepWatchLeases();
    await daemon.projectMutex.run("/p", undefined, async () => {});
    expect(watched.has("/p")).toBe(false);
  });

  it.each(["release", "sweep"] as const)(
    "preserves a new lease acquired while %s teardown waits for the project lock",
    async (trigger) => {
      await daemon.requestWatch("/p", { holder: "mcp:1", pid: 1 });
      const processor = watched.get("/p");
      const lock = await holdProjectLock("/p");
      let teardown: Promise<void> | undefined;
      try {
        teardown = queueLeaseTeardown(trigger);
        expect(daemon.listWatchLeases()).toEqual([]);
        expect(daemon.projectMutex.pending).toBe(2);
        expect(watched.get("/p")).toBe(processor);
        expect(daemon.watcherManager.unwatchProject).not.toHaveBeenCalled();

        await daemon.requestWatch("/p", { holder: "session:new" });
        expect(daemon.listWatchLeases()).toEqual([
          expect.objectContaining({ root: "/p", holder: "session:new" }),
        ]);
        expect(watched.get("/p")).toBe(processor);
      } finally {
        lock.release();
        await lock.done;
        await teardown;
        // Sweep returns void; a later lock holder observes its completed teardown.
        await daemon.projectMutex.run("/p", undefined, async () => {});
      }

      expect(watched.get("/p")).toBe(processor);
      expect(daemon.watcherManager.unwatchProject).not.toHaveBeenCalled();
      expect(daemon.watcherManager.watchProject).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["release", "sweep"] as const)(
    "detaches a genuinely unleased project after queued %s teardown gets the lock",
    async (trigger) => {
      await daemon.requestWatch("/p", { holder: "mcp:1", pid: 1 });
      const lock = await holdProjectLock("/p");
      let teardown: Promise<void> | undefined;
      try {
        teardown = queueLeaseTeardown(trigger);
        expect(daemon.listWatchLeases()).toEqual([]);
        expect(daemon.projectMutex.pending).toBe(2);
        expect(watched.has("/p")).toBe(true);
        expect(daemon.watcherManager.unwatchProject).not.toHaveBeenCalled();
      } finally {
        lock.release();
        await lock.done;
        await teardown;
        await daemon.projectMutex.run("/p", undefined, async () => {});
      }

      expect(watched.has("/p")).toBe(false);
      expect(daemon.watcherManager.unwatchProject).toHaveBeenCalledTimes(1);
      expect(daemon.listWatchLeases()).toEqual([]);
    },
  );

  it("allows unconditional operation-style unwatch despite a live lease", async () => {
    await daemon.requestWatch("/p", { holder: "session:live" });
    const lock = await holdProjectLock("/p");
    let teardown: Promise<void> | undefined;
    try {
      teardown = daemon.unwatchProject("/p");
      expect(daemon.projectMutex.pending).toBe(2);
      expect(watched.has("/p")).toBe(true);
      expect(daemon.watcherManager.unwatchProject).not.toHaveBeenCalled();
    } finally {
      lock.release();
      await lock.done;
      await teardown;
    }

    expect(watched.has("/p")).toBe(false);
    expect(daemon.watcherManager.unwatchProject).toHaveBeenCalledTimes(1);
    expect(daemon.listWatchLeases()).toEqual([
      expect.objectContaining({ root: "/p", holder: "session:live" }),
    ]);
  });

  it("reports live leases in status", async () => {
    await daemon.requestWatch("/p", { holder: "cli", ttlMs: 60_000 });
    const resp = await handleCommand(daemon, { cmd: "status" }, {} as any);
    expect(resp?.leases).toEqual([
      expect.objectContaining({ root: "/p", holder: "cli" }),
    ]);
  });
});
