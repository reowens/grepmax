import { EventEmitter } from "node:events";
import type * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/lib/daemon/daemon";
import { handleCommand } from "../src/lib/daemon/ipc-handler";
import { getWorkerPool } from "../src/lib/workers/pool";

// tests/setup.ts mocks the pool module; augment its stub pool with the
// getWorkerPids() method the orphan sweep calls.
function setTrackedPids(daemon: any, pids: number[]) {
  daemon.workerPool = getWorkerPool();
  daemon.workerPool.getWorkerPids = () => pids;
}

describe("Daemon orphan worker sweep", () => {
  let daemon: any;

  beforeEach(() => {
    daemon = new Daemon();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kills a worker only after it looks orphaned on two consecutive sweeps", () => {
    setTrackedPids(daemon, [100, 200]); // pool tracks these
    // 999 is a gmax-worker, our child, untracked → orphan candidate.
    vi.spyOn(daemon.processManager, "findProcessesByTitle").mockReturnValue([
      100, 200, 999,
    ]);
    vi.spyOn(daemon.processManager, "findChildPids").mockReturnValue([
      100, 200, 999,
    ]);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    daemon.processManager.sweepOrphanWorkers();
    expect(killSpy).not.toHaveBeenCalled(); // first sighting: only suspected

    daemon.processManager.sweepOrphanWorkers();
    expect(killSpy).toHaveBeenCalledWith(999, "SIGKILL"); // confirmed → killed
  });

  it("never kills a non-worker child (MLX / llama-server)", () => {
    setTrackedPids(daemon, [100]);
    vi.spyOn(daemon.processManager, "findProcessesByTitle").mockReturnValue([
      100,
    ]); // 555 is not a worker
    vi.spyOn(daemon.processManager, "findChildPids").mockReturnValue([
      100, 555,
    ]);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    daemon.processManager.sweepOrphanWorkers();
    daemon.processManager.sweepOrphanWorkers();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("never kills a worker owned by another process (not our child)", () => {
    setTrackedPids(daemon, [100]);
    // 777 is a gmax-worker but belongs to e.g. a per-project `gmax watch`.
    vi.spyOn(daemon.processManager, "findProcessesByTitle").mockReturnValue([
      100, 777,
    ]);
    vi.spyOn(daemon.processManager, "findChildPids").mockReturnValue([100]); // not our child
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    daemon.processManager.sweepOrphanWorkers();
    daemon.processManager.sweepOrphanWorkers();
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe("Daemon repair safety", () => {
  it("fails closed before destructive rebuild prerequisites exist", async () => {
    const daemon = new Daemon();
    const conn = {
      writable: true,
      write: vi.fn(),
      end: vi.fn(),
    } as unknown as net.Socket;

    await daemon.repairRebuild(conn);

    expect(conn.write).toHaveBeenCalledOnce();
    const response = JSON.parse(
      String(vi.mocked(conn.write).mock.calls[0][0]).trim(),
    );
    expect(response).toMatchObject({
      type: "done",
      ok: false,
      error: expect.stringContaining("resources not ready"),
    });
  });
});

describe("Daemon readiness gate (IPC)", () => {
  let daemon: any;
  const conn = {} as any;

  beforeEach(() => {
    daemon = new Daemon();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers ping before resources are open", async () => {
    expect(daemon.isReady()).toBe(false);
    const resp = await handleCommand(daemon, { cmd: "ping" }, conn);
    expect(resp?.ok).toBe(true);
    expect(resp?.ready).toBe(false);
    expect(resp?.capabilities).toEqual({ exclusiveGenerationRebuild: 1 });
  });

  it("reports ready on ping once resources are open", async () => {
    daemon.ready = true;
    const resp = await handleCommand(daemon, { cmd: "ping" }, conn);
    expect(resp?.ok).toBe(true);
    expect(resp?.ready).toBe(true);
  });

  it("rejects resource-dependent commands until ready", async () => {
    const resp = await handleCommand(daemon, { cmd: "status" }, conn);
    expect(resp).toEqual({ ok: false, error: "daemon initializing" });
  });

  it("allows resource-dependent commands once ready", async () => {
    daemon.ready = true;
    const resp = await handleCommand(daemon, { cmd: "status" }, conn);
    expect(resp?.ok).toBe(true);
  });

  it("rejects repair commands without the negotiated protocol", async () => {
    daemon.ready = true;
    const resp = await handleCommand(
      daemon,
      { cmd: "repair-v2", protocol: 0 },
      conn,
    );
    expect(resp).toMatchObject({
      ok: false,
      code: "REBUILD_PROTOCOL_REQUIRED",
    });
  });

  it("returns a structured busy response while exclusive work is pending", async () => {
    daemon.ready = true;
    let releaseQuiesce!: () => void;
    const exclusive = daemon.operations.runExclusive(
      "repair",
      () =>
        new Promise<void>((resolve) => {
          releaseQuiesce = resolve;
        }),
      async () => {},
    );

    const resp = await handleCommand(
      daemon,
      { cmd: "search", projectRoot: "/project", query: "query" },
      new EventEmitter() as any,
    );

    expect(resp).toMatchObject({
      ok: false,
      code: "DAEMON_BUSY",
      error: expect.stringContaining("repair"),
    });
    releaseQuiesce();
    await exclusive;
  });

  it("returns a structured closing response after admission closes", async () => {
    daemon.ready = true;
    await daemon.operations.close();

    const resp = await handleCommand(
      daemon,
      { cmd: "search", projectRoot: "/project", query: "query" },
      new EventEmitter() as any,
    );

    expect(resp).toEqual({
      ok: false,
      code: "DAEMON_CLOSING",
      error: "daemon is closing",
    });
  });
});

describe("Daemon self-recycle", () => {
  let daemon: any;

  beforeEach(() => {
    daemon = new Daemon();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recycles when RSS exceeds the watermark and the daemon is quiet", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    const shutdownSpy = vi
      .spyOn(daemon, "shutdown")
      .mockResolvedValue(undefined);
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 4096 * 1024 * 1024,
    } as unknown as NodeJS.MemoryUsage);

    daemon.maybeRecycle();

    expect(shutdownSpy).toHaveBeenCalledWith({ relaunch: true });
    expect(daemon.recycling).toBe(true);
    // Flush the shutdown().finally(() => process.exit(0)) microtask while the
    // exit spy is still installed, so the real exit is never reached.
    await Promise.resolve();
    await Promise.resolve();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not recycle while a project operation is in flight", async () => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const shutdownSpy = vi
      .spyOn(daemon, "shutdown")
      .mockResolvedValue(undefined);
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 4096 * 1024 * 1024,
    } as unknown as NodeJS.MemoryUsage);
    let release!: () => void;
    const active = daemon.projectMutex.run(
      "/some/project",
      undefined,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();

    daemon.maybeRecycle();

    expect(shutdownSpy).not.toHaveBeenCalled();
    release();
    await active;
  });

  it("does not recycle when under both ceilings", () => {
    const shutdownSpy = vi
      .spyOn(daemon, "shutdown")
      .mockResolvedValue(undefined);
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 100 * 1024 * 1024,
    } as unknown as NodeJS.MemoryUsage);

    daemon.maybeRecycle();

    expect(shutdownSpy).not.toHaveBeenCalled();
  });
});

describe("Daemon project operation cancellation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not start a queued add after its client disconnects", async () => {
    const daemon: any = new Daemon();
    let release!: () => void;
    const active = daemon.projectMutex.run(
      "/queued/project",
      undefined,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const conn = new EventEmitter() as EventEmitter & {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    conn.writable = true;
    conn.write = vi.fn();
    conn.end = vi.fn();

    const pending = daemon.addProject("/queued/project", conn);
    conn.emit("close");
    release();
    await active;
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect(conn.write).not.toHaveBeenCalled();
    expect(conn.end).not.toHaveBeenCalled();
  });
});

describe("Daemon shutdown coordination", () => {
  it("returns one promise to every shutdown caller", async () => {
    const daemon: any = new Daemon();
    let finish!: () => void;
    const perform = vi.spyOn(daemon, "performShutdown").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const first = daemon.shutdown();
    const second = daemon.shutdown({ relaunch: true });

    expect(second).toBe(first);
    expect(perform).toHaveBeenCalledOnce();
    expect(perform).toHaveBeenCalledWith({});

    finish();
    await first;
  });
});
