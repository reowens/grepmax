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
    await vi.waitFor(() => expect(watched.has("/p")).toBe(false));
  });

  it("reports live leases in status", async () => {
    await daemon.requestWatch("/p", { holder: "cli", ttlMs: 60_000 });
    const resp = await handleCommand(daemon, { cmd: "status" }, {} as any);
    expect(resp?.leases).toEqual([
      expect.objectContaining({ root: "/p", holder: "cli" }),
    ]);
  });
});
