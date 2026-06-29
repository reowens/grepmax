import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/lib/daemon/daemon";
import { handleCommand } from "../src/lib/daemon/ipc-handler";
import { getWorkerPool } from "../src/lib/workers/pool";

// tests/setup.ts mocks the pool module; augment its stub pool with the
// getWorkerPids() method the orphan sweep calls.
function setTrackedPids(pids: number[]) {
  (getWorkerPool() as any).getWorkerPids = () => pids;
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
    setTrackedPids([100, 200]); // pool tracks these
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
    setTrackedPids([100]);
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
    setTrackedPids([100]);
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

  it("does not recycle while a project operation is in flight", () => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const shutdownSpy = vi
      .spyOn(daemon, "shutdown")
      .mockResolvedValue(undefined);
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 4096 * 1024 * 1024,
    } as unknown as NodeJS.MemoryUsage);
    daemon.projectLocks.set("/some/project", Promise.resolve());

    daemon.maybeRecycle();

    expect(shutdownSpy).not.toHaveBeenCalled();
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
