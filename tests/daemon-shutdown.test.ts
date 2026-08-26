import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  unlinkSync: vi.fn(),
}));

vi.mock("../src/lib/utils/daemon-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/utils/daemon-client")>()),
  writeDrainingMarker: vi.fn(),
  clearDrainingMarker: vi.fn(),
}));

vi.mock("../src/lib/utils/watcher-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/utils/watcher-store")>()),
  unregisterDaemon: vi.fn(),
  unregisterWatcherByRoot: vi.fn(),
}));

import { Daemon } from "../src/lib/daemon/daemon";
import { destroyWorkerPool } from "../src/lib/workers/pool";

describe("Daemon coordinated shutdown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is single-flight and drains operations before workers and stores", async () => {
    const events: string[] = [];
    const daemon: any = new Daemon();
    daemon.ready = true;
    daemon.server = {
      listening: true,
      close: (done: () => void) => {
        events.push("server");
        done();
      },
    };
    const connection = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    connection.end = vi.fn(() => events.push("connection"));
    connection.destroy = vi.fn();
    daemon.connections.add(connection);
    daemon.releaseLock = vi.fn(async () => {
      events.push("lock");
    });
    vi.spyOn(daemon.operations, "close").mockImplementation(async () => {
      events.push("operations");
    });
    vi.spyOn(daemon.projectMutex, "close").mockImplementation(async () => {
      events.push("mutex");
    });
    vi.spyOn(daemon.watcherManager, "quiesceAll").mockImplementation(
      async () => {
        events.push("watchers");
        return [];
      },
    );
    daemon.llmServer = {
      stop: vi.fn(async () => events.push("llm")),
    };
    daemon.mlxServerManager.stopMlxServer = vi.fn(() => events.push("mlx"));
    daemon.metaCache = { close: vi.fn(async () => events.push("meta")) };
    daemon.vectorDb = {
      abortLeaseWaits: vi.fn(),
      close: vi.fn(async () => events.push("vector")),
    };
    vi.mocked(destroyWorkerPool).mockImplementation(async () => {
      events.push("workers");
    });

    const first = daemon.shutdown();
    const second = daemon.shutdown({ relaunch: true });
    expect(second).toBe(first);
    await first;

    expect(events.indexOf("server")).toBeLessThan(events.indexOf("operations"));
    expect(events.indexOf("watchers")).toBeLessThan(events.indexOf("workers"));
    expect(events.indexOf("operations")).toBeLessThan(
      events.indexOf("workers"),
    );
    expect(events.indexOf("mutex")).toBeLessThan(events.indexOf("workers"));
    expect(events.indexOf("workers")).toBeLessThan(events.indexOf("meta"));
    expect(events.indexOf("workers")).toBeLessThan(events.indexOf("vector"));
    expect(events.indexOf("mlx")).toBeLessThan(events.indexOf("vector"));
    expect(connection.end).toHaveBeenCalledOnce();
  });
});

describe("Daemon shutdown never waits forever on a wedged operation", () => {
  beforeEach(() => vi.clearAllMocks());

  function wireMinimalDaemon(events: string[]) {
    const daemon: any = new Daemon();
    daemon.ready = true;
    daemon.server = { listening: false };
    daemon.releaseLock = vi.fn(async () => {});
    vi.spyOn(daemon.watcherManager, "quiesceAll").mockImplementation(
      async () => {
        events.push("watchers");
        return [];
      },
    );
    daemon.mlxServerManager.stopMlxServer = vi.fn(() => events.push("mlx"));
    daemon.metaCache = { close: vi.fn(async () => events.push("meta")) };
    vi.mocked(destroyWorkerPool).mockImplementation(async () => {
      events.push("workers");
    });
    return daemon;
  }

  it("aborts VectorDB lease waits before draining operations", async () => {
    // A remove/repair polling StoreLease.acquireExclusive listens only to the
    // VectorDB's lease abort, which close() fires — after the drain. Shutdown
    // must fire it first or a lease that never frees deadlocks the drain.
    const events: string[] = [];
    const daemon = wireMinimalDaemon(events);
    daemon.vectorDb = {
      abortLeaseWaits: vi.fn(() => events.push("lease-abort")),
      close: vi.fn(async () => events.push("vector")),
    };
    vi.spyOn(daemon.operations, "close").mockImplementation(async () => {
      events.push("operations");
    });
    vi.spyOn(daemon.projectMutex, "close").mockImplementation(async () => {
      events.push("mutex");
    });

    await daemon.shutdown();

    expect(events.indexOf("lease-abort")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("lease-abort")).toBeLessThan(
      events.indexOf("operations"),
    );
    expect(events.indexOf("lease-abort")).toBeLessThan(events.indexOf("mutex"));
    expect(events.indexOf("lease-abort")).toBeLessThan(
      events.indexOf("vector"),
    );
  });

  it("abandons a drain that never settles and still releases resources", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events: string[] = [];
      const daemon = wireMinimalDaemon(events);
      daemon.vectorDb = {
        abortLeaseWaits: vi.fn(),
        close: vi.fn(async () => events.push("vector")),
      };
      vi.spyOn(daemon.operations, "close").mockImplementation(
        () => new Promise<void>(() => {}), // wedged forever
      );
      vi.spyOn(daemon.operations, "activeOperationNames").mockReturnValue([
        "remove-project",
      ]);
      vi.spyOn(daemon.projectMutex, "close").mockImplementation(async () => {
        events.push("mutex");
      });
      vi.spyOn(daemon.projectMutex, "pendingKeys").mockReturnValue([
        "/tmp/wedged-root",
      ]);

      let settled = false;
      const done = daemon.shutdown().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      await done;

      expect(events).toContain("workers");
      expect(events).toContain("vector");
      expect(events).toContain("meta");
      const message = errors.mock.calls.map((c) => String(c[0])).join("\n");
      expect(message).toMatch(/shutdown drain timed out/);
      expect(message).toContain("remove-project");
      expect(message).toContain("/tmp/wedged-root");
    } finally {
      errors.mockRestore();
      vi.useRealTimers();
    }
  });
});
