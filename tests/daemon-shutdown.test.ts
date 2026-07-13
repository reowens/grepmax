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
    daemon.vectorDb = { close: vi.fn(async () => events.push("vector")) };
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
