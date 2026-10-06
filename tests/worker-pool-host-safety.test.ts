import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  quarantine: null as string | null,
  memory: { status: "known", pressure: "normal" } as any,
  kernel: { status: "known", usage: { pressure: "ok" } } as any,
  children: [] as any[],
  memoryProbe: vi.fn(),
  kernelProbe: vi.fn(),
  quarantineProbe: vi.fn(),
  latch: vi.fn(),
}));

vi.mock("../src/lib/utils/autostart", () => ({
  daemonStartDeniedReason: h.quarantineProbe,
}));
vi.mock("../src/lib/utils/safety-latch", () => ({ latchSafetyStop: h.latch }));
vi.mock("../src/lib/utils/kernel-zone", () => ({
  probeMemoryPressure: h.memoryProbe,
  probeKernelZoneUsage: h.kernelProbe,
  formatPressureProbe: (value: any) => JSON.stringify({ status: value.status }),
}));
vi.mock("../src/lib/utils/logger", () => ({ log: vi.fn(), debug: vi.fn() }));
vi.mock("../src/lib/index/index-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/index/index-config")>()),
  readGlobalConfig: () => ({
    modelTier: "small",
    vectorDim: 384,
    embedMode: "cpu",
  }),
}));
vi.mock("../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config")>();
  return { ...actual, CONFIG: { ...actual.CONFIG, WORKER_THREADS: 2 } };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    fork: vi.fn(() => {
      const child: any = new EventEmitter();
      child.pid = 1000 + h.children.length;
      child.connected = true;
      child.send = vi.fn();
      child.kill = vi.fn(() => true);
      h.children.push(child);
      return child;
    }),
  };
});
vi.unmock("../src/lib/workers/pool");

import { WorkerPool } from "../src/lib/workers/pool";

describe("WorkerPool host admission", () => {
  let pool: any;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    h.quarantine = null;
    h.memory = { status: "known", pressure: "normal" };
    h.kernel = { status: "known", usage: { pressure: "ok" } };
    h.children.length = 0;
    h.memoryProbe.mockReset().mockImplementation(() => h.memory);
    h.kernelProbe.mockReset().mockImplementation(() => h.kernel);
    h.quarantineProbe.mockReset().mockImplementation(() => h.quarantine);
    h.latch.mockReset();
    vi.mocked(childProcess.fork).mockClear();
  });
  afterEach(() => {
    if (pool) pool.destroyed = true;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    pool = undefined;
  });

  it("refuses a quarantined constructor before any probes, fork or timer", () => {
    h.quarantine = "existing quarantine";
    expect(() => new WorkerPool()).toThrow("existing quarantine");
    expect(childProcess.fork).not.toHaveBeenCalled();
    expect(h.memoryProbe).not.toHaveBeenCalled();
    expect(h.kernelProbe).not.toHaveBeenCalled();
    expect(h.latch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { status: "known", pressure: "warn" },
    { status: "known", pressure: "critical" },
    { status: "unknown", reason: "timeout" },
    { status: "unsupported", reason: "unsupported-platform" },
  ])("requires known-normal OS pressure: %j", (result) => {
    h.memory = result;
    expect(() => new WorkerPool()).toThrow("OS memory pressure");
    expect(childProcess.fork).not.toHaveBeenCalled();
    expect(h.kernelProbe).not.toHaveBeenCalled();
    expect(h.latch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { status: "known", usage: { pressure: "warn" } },
    { status: "known", usage: { pressure: "critical" } },
    { status: "unknown", reason: "parse" },
    { status: "unsupported", reason: "unsupported-platform" },
  ])("requires known-ok kernel pressure: %j", (result) => {
    h.kernel = result;
    expect(() => new WorkerPool()).toThrow("kernel pressure");
    expect(childProcess.fork).not.toHaveBeenCalled();
    expect(h.latch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks quarantine after the probes and before fork", () => {
    h.kernelProbe.mockImplementation(() => {
      h.quarantine = "concurrent stop";
      return h.kernel;
    });
    expect(() => new WorkerPool()).toThrow("concurrent stop");
    expect(childProcess.fork).not.toHaveBeenCalled();
    expect(h.latch).not.toHaveBeenCalled();
  });

  it("refreshes OS pressure after a slow kernel probe", () => {
    h.kernelProbe.mockImplementation(() => {
      h.memory = { status: "known", pressure: "warn" };
      return h.kernel;
    });
    expect(() => new WorkerPool()).toThrow("OS memory pressure warn");
    expect(h.memoryProbe).toHaveBeenCalledTimes(2);
    expect(childProcess.fork).not.toHaveBeenCalled();
  });

  it("keeps non-Darwin pressure behavior while enforcing quarantine", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    pool = new WorkerPool();
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    expect(h.memoryProbe).not.toHaveBeenCalled();
    expect(h.kernelProbe).not.toHaveBeenCalled();
    h.quarantine = "blocked";
    expect(pool.spawnWorker()).toBe(false);
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
  });

  it("settles a denied scale-up timer and never retries the pool", async () => {
    pool = new WorkerPool();
    pool.workers[0].busy = true;
    const task = pool.processFile({ path: "/repo/a.ts", projectRoot: "/repo" });
    const rejected = expect(task).rejects.toMatchObject({
      code: "HOST_SAFETY",
    });
    h.memory = { status: "unknown", reason: "timeout" };
    await vi.advanceTimersByTimeAsync(2001);
    await rejected;
    expect(pool.tasks.size).toBe(0);
    expect(pool.scaleUpTimer).toBe(null);
    expect(pool.isHealthy()).toBe(false);
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    h.memory = { status: "known", pressure: "normal" };
    await expect(pool.encodeQuery("later")).rejects.toMatchObject({
      code: "HOST_SAFETY",
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    expect(h.latch).toHaveBeenCalledTimes(1);
  });

  it("rejects search expansion immediately instead of assigning a busy worker", async () => {
    pool = new WorkerPool();
    pool.workers[0].busy = true;
    h.kernel = { status: "known", usage: { pressure: "warn" } };
    await expect(pool.encodeQuery("query")).rejects.toMatchObject({
      code: "HOST_SAFETY",
    });
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    expect(h.children[0].send).not.toHaveBeenCalled();
    expect(pool.tasks.size).toBe(0);
  });

  it("denies exit-handler respawn without an uncaught callback or hanging queue", async () => {
    pool = new WorkerPool();
    const assigned = pool.processFile({
      path: "/repo/a.ts",
      projectRoot: "/repo",
    });
    const failed = expect(assigned).rejects.toThrow();
    const queued = pool.processFile({
      path: "/repo/b.ts",
      projectRoot: "/repo",
    });
    const denied = expect(queued).rejects.toMatchObject({
      code: "HOST_SAFETY",
    });
    h.memory = { status: "known", pressure: "critical" };
    expect(() => h.children[0].emit("exit", 1, null)).not.toThrow();
    await Promise.all([failed, denied]);
    expect(pool.tasks.size).toBe(0);
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
  });

  it("settles pending tasks when the no-progress timer cannot replace a worker", async () => {
    pool = new WorkerPool();
    const assigned = pool.processFile({
      path: "/repo/a.ts",
      projectRoot: "/repo",
    });
    const failed = expect(assigned).rejects.toThrow("no progress limit");
    // Keep the queue behind one worker until its task timeout triggers.
    pool.maxWorkers = 1;
    const queued = pool.processFile({
      path: "/repo/b.ts",
      projectRoot: "/repo",
    });
    const denied = expect(queued).rejects.toMatchObject({
      code: "HOST_SAFETY",
    });
    h.kernel = { status: "unknown", reason: "timeout" };
    await vi.advanceTimersByTimeAsync(120001);
    await Promise.all([failed, denied]);
    expect(pool.tasks.size).toBe(0);
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    expect(h.latch).toHaveBeenCalledTimes(1);
  });

  it("contains a thrown admission probe before constructor fork", () => {
    h.memoryProbe.mockImplementation(() => {
      throw new Error("probe failed");
    });
    expect(() => new WorkerPool()).toThrow("host admission or fork failed");
    expect(childProcess.fork).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("breaks replacement-floor loops after denied bloat recycling", () => {
    pool = new WorkerPool();
    h.memory = { status: "known", pressure: "warn" };
    expect(() => pool.recycleWorker(pool.workers[0], "test")).not.toThrow();
    expect(pool.workers).toHaveLength(0);
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    expect(h.latch).toHaveBeenCalledTimes(1);
  });

  it("remains blocked when latch persistence fails", async () => {
    pool = new WorkerPool();
    pool.workers[0].busy = true;
    h.memory = { status: "unknown", reason: "exit" };
    h.latch.mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    await expect(pool.encodeQuery("query")).rejects.toMatchObject({
      code: "HOST_SAFETY",
    });
    expect(pool.spawnWorker()).toBe(false);
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
  });

  it("contains synchronous fork failure on a replacement callback", () => {
    pool = new WorkerPool();
    vi.mocked(childProcess.fork).mockImplementationOnce(() => {
      throw new Error("ENOMEM");
    });
    expect(() => h.children[0].emit("exit", 1, null)).not.toThrow();
    expect(pool.spawnDeniedReason).toContain("host admission or fork failed");
    expect(h.latch).toHaveBeenCalledTimes(1);
  });
});
