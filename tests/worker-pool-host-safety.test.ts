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

import { resourceBudget } from "../src/lib/utils/resource-budget";
import {
  EXISTING_QUERY_QUEUE_LIMIT,
  EXISTING_QUERY_WAIT_MS,
  WorkerPool,
} from "../src/lib/workers/pool";

describe("WorkerPool host admission", () => {
  let pool: any;
  beforeEach(() => {
    vi.stubEnv("GMAX_HOST_GUARD_POLICY", "strict");
    vi.useFakeTimers();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    vi.mocked(resourceBudget.checkExisting).mockReset().mockReturnValue(null);
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
    vi.unstubAllEnvs();
    pool = undefined;
  });

  it.each(["warn", "unknown"])(
    "critical-only forks under %s pressure",
    (pressure) => {
      vi.stubEnv("GMAX_HOST_GUARD_POLICY", "critical-only");
      h.memory =
        pressure === "warn"
          ? { status: "known", pressure: "warn" }
          : { status: "unknown", reason: "timeout" };
      h.kernel = { status: "unknown", reason: "timeout" };
      pool = new WorkerPool();
      expect(childProcess.fork).toHaveBeenCalled();
      expect(h.latch).not.toHaveBeenCalled();
    },
  );
  it("critical-only still refuses kernel-critical even with OS warning", () => {
    vi.stubEnv("GMAX_HOST_GUARD_POLICY", "critical-only");
    h.memory = { status: "known", pressure: "warn" };
    h.kernel = { status: "known", usage: { pressure: "critical" } };
    expect(() => new WorkerPool()).toThrow("kernel pressure critical");
    expect(childProcess.fork).not.toHaveBeenCalled();
    expect(h.latch).toHaveBeenCalledOnce();
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
    expect(h.latch).toHaveBeenCalledTimes(
      result.status === "known" && result.pressure === "critical" ? 1 : 0,
    );
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
    expect(h.latch).toHaveBeenCalledTimes(
      result.status === "known" && result.usage?.pressure === "critical"
        ? 1
        : 0,
    );
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
    expect(h.latch).not.toHaveBeenCalled();
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
    expect(h.latch).not.toHaveBeenCalled();
  });

  it("contains a thrown admission probe before constructor fork", () => {
    h.memoryProbe.mockImplementation(() => {
      throw new Error("probe failed");
    });
    expect(() => new WorkerPool()).toThrow("probe failed");
    expect(childProcess.fork).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects pre-existing queued work before dispatching to an idle worker after quarantine", async () => {
    pool = new WorkerPool();
    pool.maxWorkers = 1;
    const assigned = pool.encodeQuery("first");
    const queued = pool.encodeQuery("queued");
    const denied = expect(queued).rejects.toMatchObject({
      code: "HOST_SAFETY",
    });
    const worker = pool.workers[0];
    const pressureCalls = [
      h.memoryProbe.mock.calls.length,
      h.kernelProbe.mock.calls.length,
    ];
    h.quarantine = "concurrent quarantine";
    worker.child.emit("message", { id: worker.pendingTaskId, result: [] });
    await assigned;
    await denied;
    expect(worker.child.send).toHaveBeenCalledTimes(1);
    expect(pool.tasks.size).toBe(0);
    expect(h.latch).not.toHaveBeenCalled();
    expect([
      h.memoryProbe.mock.calls.length,
      h.kernelProbe.mock.calls.length,
    ]).toEqual(pressureCalls);
    h.quarantine = null;
    await expect(pool.encodeQuery("later")).rejects.toMatchObject({
      code: "HOST_SAFETY",
    });
    expect(worker.child.send).toHaveBeenCalledTimes(1);
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
  });

  it("breaks replacement-floor loops after denied bloat recycling", () => {
    pool = new WorkerPool();
    h.memory = { status: "known", pressure: "warn" };
    expect(() => pool.recycleWorker(pool.workers[0], "test")).not.toThrow();
    expect(pool.workers).toHaveLength(0);
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    expect(h.latch).not.toHaveBeenCalled();
  });

  it("remains blocked when latch persistence fails", async () => {
    pool = new WorkerPool();
    pool.workers[0].busy = true;
    h.memory = { status: "known", pressure: "critical" };
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
    expect(pool.spawnDeniedReason).toContain("ENOMEM");
    expect(h.latch).not.toHaveBeenCalled();
  });
  it("cold queries refuse and busy warm queries expire without spawning or killing", async () => {
    pool = new WorkerPool();
    await expect(pool.encodeQueryExisting("cold")).rejects.toThrow(
      "embedding_unavailable",
    );
    pool.workers[0].queryReady = true;
    pool.workers[0].busy = true;
    const result = pool.encodeQueryExisting("busy");
    const rejected = expect(result).rejects.toThrow("busy");
    expect(pool.existingWaiters.size).toBe(1);
    expect(resourceBudget.checkExisting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EXISTING_QUERY_WAIT_MS);
    await rejected;
    expect(pool.existingWaiters.size).toBe(0);
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    expect(pool.hasUnassignedTasks()).toBe(false);
    expect(h.children[0].send).not.toHaveBeenCalled();
    expect(h.children[0].kill).not.toHaveBeenCalled();
  });
  it("gives a waiting document query the next warm worker before another indexing file", async () => {
    pool = new WorkerPool();
    pool.maxWorkers = 1;
    const worker = pool.workers[0];
    worker.queryReady = true;
    const first = pool.processFile({ path: "/first.ts" });
    const firstId = worker.pendingTaskId;
    const second = pool.processFile({ path: "/second.ts" });
    const query = pool.encodeQueryExisting("PRIVATE_QUERY");
    expect(pool.existingQueryState()).toBe("ready");
    expect(pool.existingWaiters.size).toBe(1);
    expect(worker.child.send).toHaveBeenCalledTimes(1);
    worker.child.emit("message", { id: firstId, result: {}, queryReady: true });
    await first;
    expect(worker.child.send.mock.calls[1][0]).toMatchObject({
      method: "encodeQuery",
      payload: { existingOnly: true, text: "PRIVATE_QUERY" },
    });
    worker.child.emit("message", {
      id: worker.pendingTaskId,
      result: { dense: [1] },
      queryReady: true,
    });
    await expect(query).resolves.toMatchObject({ dense: [1] });
    expect(worker.child.send.mock.calls[2][0]).toMatchObject({
      method: "processFile",
      payload: { path: "/second.ts" },
    });
    worker.child.emit("message", { id: worker.pendingTaskId, result: {} });
    await second;
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    expect(pool.tasks.size).toBe(0);
    expect(pool.existingWaiters.size).toBe(0);
  });
  it("caps waiting queries and preserves FIFO without scaling for them", async () => {
    pool = new WorkerPool();
    const worker = pool.workers[0];
    worker.queryReady = true;
    worker.busy = true;
    const queries = Array.from({ length: EXISTING_QUERY_QUEUE_LIMIT }, (_, i) =>
      pool.encodeQueryExisting(`query-${i}`),
    );
    expect(pool.existingQueryState()).toBe("busy");
    await expect(pool.encodeQueryExisting("overflow")).rejects.toThrow("busy");
    worker.busy = false;
    pool.dispatch();
    for (let i = 0; i < queries.length; i++) {
      expect(worker.child.send.mock.calls[i][0].payload.text).toBe(
        `query-${i}`,
      );
      worker.child.emit("message", {
        id: worker.pendingTaskId,
        result: { dense: [i] },
        queryReady: true,
      });
      await queries[i];
    }
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    expect(pool.existingWaiters.size).toBe(0);
  });
  it("withdraws queued cancellation and cancellation during admission before sending", async () => {
    pool = new WorkerPool();
    const worker = pool.workers[0];
    worker.queryReady = true;
    worker.busy = true;
    const controller = new AbortController();
    const query = pool.encodeQueryExisting("cancelled", controller.signal);
    controller.abort();
    await expect(query).rejects.toThrow("Aborted");
    expect(pool.existingWaiters.size).toBe(0);
    worker.busy = false;
    const during = new AbortController();
    vi.mocked(resourceBudget.checkExisting).mockImplementationOnce(() => {
      during.abort();
      return null;
    });
    await expect(
      pool.encodeQueryExisting("race", during.signal),
    ).rejects.toThrow("Aborted");
    expect(worker.child.send).not.toHaveBeenCalled();
    expect(worker.child.kill).not.toHaveBeenCalled();
    expect(pool.tasks.size).toBe(0);
    expect(pool.existingWaiters.size).toBe(0);
  });
  it.each(["cold", "quarantine", "pressure", "destroy"])(
    "queued queries fail safely when %s changes before dispatch",
    async (mode) => {
      pool = new WorkerPool();
      const worker = pool.workers[0];
      worker.queryReady = true;
      worker.busy = true;
      const query = pool.encodeQueryExisting("PRIVATE_QUERY");
      const rejected = expect(query).rejects.toThrow();
      worker.busy = false;
      if (mode === "cold") worker.queryReady = false;
      if (mode === "quarantine") h.quarantine = "concurrent stop";
      if (mode === "pressure")
        vi.mocked(resourceBudget.checkExisting).mockImplementationOnce(() => {
          throw new Error("pressure changed");
        });
      if (mode === "destroy") {
        const destroyed = pool.destroy();
        worker.child.emit("exit", 0, null);
        await destroyed;
      } else pool.dispatch();
      await rejected;
      expect(pool.existingWaiters.size).toBe(0);
      expect(worker.child.send).not.toHaveBeenCalled();
      expect(childProcess.fork).toHaveBeenCalledTimes(1);
    },
  );
  it("lets indexing resume after a bounded burst even while document queries remain queued", async () => {
    pool = new WorkerPool();
    pool.maxWorkers = 1;
    const worker = pool.workers[0];
    worker.queryReady = true;
    const queries = [pool.encodeQueryExisting("query-0")];
    const indexing = pool.processFile({ path: "/waiting.ts" });
    for (let i = 1; i <= EXISTING_QUERY_QUEUE_LIMIT; i++)
      queries.push(pool.encodeQueryExisting(`query-${i}`));
    for (let i = 0; i < EXISTING_QUERY_QUEUE_LIMIT; i++) {
      worker.child.emit("message", {
        id: worker.pendingTaskId,
        result: { dense: [i] },
        queryReady: true,
      });
      await queries[i];
    }
    expect(worker.child.send.mock.calls.at(-1)[0]).toMatchObject({
      method: "processFile",
      payload: { path: "/waiting.ts" },
    });
    expect(pool.existingWaiters.size).toBe(1);
    worker.child.emit("message", { id: worker.pendingTaskId, result: {} });
    await indexing;
    expect(worker.child.send.mock.calls.at(-1)[0].method).toBe("encodeQuery");
    worker.child.emit("message", {
      id: worker.pendingTaskId,
      result: { dense: [4] },
      queryReady: true,
    });
    await queries[queries.length - 1];
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
  });
  it("does not let a document admission refusal strand ordinarily admitted indexing", async () => {
    pool = new WorkerPool();
    pool.maxWorkers = 1;
    const worker = pool.workers[0];
    worker.queryReady = true;
    const first = pool.processFile({ path: "/first.ts" });
    const firstId = worker.pendingTaskId;
    const second = pool.processFile({ path: "/second.ts" });
    const query = pool.encodeQueryExisting("refused");
    const rejected = expect(query).rejects.toThrow("host_pressure");
    vi.mocked(resourceBudget.checkExisting).mockImplementationOnce(() => {
      throw new Error("document admission unavailable");
    });
    worker.child.emit("message", { id: firstId, result: {}, queryReady: true });
    await first;
    await rejected;
    expect(worker.child.send.mock.calls.at(-1)[0]).toMatchObject({
      method: "processFile",
      payload: { path: "/second.ts" },
    });
    worker.child.emit("message", { id: worker.pendingTaskId, result: {} });
    await second;
  });
  it.each(["throw", "return"])(
    "does not dispatch indexing when containment appears during admission (%s)",
    async (mode) => {
      pool = new WorkerPool();
      pool.maxWorkers = 1;
      const worker = pool.workers[0];
      worker.queryReady = true;
      const first = pool.processFile({ path: "/first.ts" });
      const firstId = worker.pendingTaskId;
      const second = pool.processFile({ path: "/second.ts" });
      const rejectedIndex = expect(second).rejects.toThrow("concurrent stop");
      const query = pool.encodeQueryExisting("refused");
      const rejectedQuery = expect(query).rejects.toThrow("host_pressure");
      vi.mocked(resourceBudget.checkExisting).mockImplementationOnce(() => {
        h.quarantine = "concurrent stop";
        if (mode === "throw") throw new Error("containment");
        return null;
      });
      worker.child.emit("message", {
        id: firstId,
        result: {},
        queryReady: true,
      });
      await first;
      await rejectedQuery;
      await rejectedIndex;
      expect(worker.child.send).toHaveBeenCalledTimes(1);
    },
  );
  it("does not send a query when admission consumes its absolute request deadline", async () => {
    pool = new WorkerPool();
    const worker = pool.workers[0];
    worker.queryReady = true;
    vi.mocked(resourceBudget.checkExisting).mockImplementationOnce(() => {
      vi.setSystemTime(Date.now() + 10001);
      return null;
    });
    await expect(pool.encodeQueryExisting("expired")).rejects.toThrow(
      "timeout",
    );
    expect(worker.child.send).not.toHaveBeenCalled();
    expect(worker.child.kill).not.toHaveBeenCalled();
    expect(pool.existingWaiters.size).toBe(0);
    expect(pool.tasks.size).toBe(0);
  });
  it("does not replace a lost restricted worker solely for waiting queries", async () => {
    pool = new WorkerPool();
    const worker = pool.workers[0];
    worker.queryReady = true;
    const running = pool.encodeQueryExisting("running");
    const waiting = pool.encodeQueryExisting("waiting");
    const rejectedRunning = expect(running).rejects.toThrow("exited");
    const rejectedWaiting = expect(waiting).rejects.toThrow(
      "embedding_unavailable",
    );
    worker.child.emit("exit", 1, null);
    await rejectedRunning;
    await rejectedWaiting;
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    expect(pool.tasks.size).toBe(0);
    expect(pool.existingWaiters.size).toBe(0);
  });
  it.each(["normal", "abort", "deadline", "death"])(
    "existing %s keeps shared lifecycle without replacement",
    async (mode) => {
      pool = new WorkerPool();
      const worker = pool.workers[0];
      worker.queryReady = true;
      const controller = new AbortController();
      const result = pool.encodeQueryExisting(
        "PRIVATE_QUERY",
        controller.signal,
      );
      const expected =
        mode === "normal"
          ? expect(result).resolves.toMatchObject({ dense: [1] })
          : expect(result).rejects.toThrow();
      expect(worker.child.send).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "encodeQuery",
          payload: {
            text: "PRIVATE_QUERY",
            existingOnly: true,
            generation: pool.generation.fingerprint,
          },
        }),
      );
      if (mode === "abort") controller.abort();
      if (mode === "deadline") {
        worker.child.emit("message", {
          id: worker.pendingTaskId,
          heartbeat: true,
          queryReady: true,
        });
        await vi.advanceTimersByTimeAsync(10001);
      }
      if (mode === "death") worker.child.emit("exit", 1, null);
      else {
        if (mode !== "normal") expect(worker.busy).toBe(true);
        worker.child.emit("message", {
          id: worker.pendingTaskId,
          result: { dense: [1] },
          queryReady: true,
          rss: 10 * 1024 * 1024 * 1024,
        });
      }
      await expected;
      pool.reapBloatedWorkers();
      expect(childProcess.fork).toHaveBeenCalledTimes(1);
      if (mode === "death") expect(worker.child.kill).not.toHaveBeenCalled();
      else expect(worker.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(pool.workers).toHaveLength(0);
      await expect(
        pool.encodeQueryExisting("after retirement"),
      ).rejects.toThrow("embedding_unavailable");
      expect(childProcess.fork).toHaveBeenCalledTimes(1);
      expect(pool.tasks.size).toBe(0);
    },
  );
  it("retires repeated oversized restricted completions without interrupting busy inference or spawning", async () => {
    pool = new WorkerPool();
    const worker = pool.workers[0];
    worker.queryReady = true;
    const reservations = vi.mocked(resourceBudget.reserve).mock.results;
    const reservation = reservations[reservations.length - 1].value;
    for (let i = 0; i < 2; i++) {
      const result = pool.encodeQueryExisting("bounded query");
      worker.lastRssBytes = 10 * 1024 * 1024 * 1024;
      pool.reapBloatedWorkers();
      expect(worker.child.kill).not.toHaveBeenCalled();
      worker.child.emit("message", {
        id: worker.pendingTaskId,
        result: { dense: [1] },
        queryReady: true,
        rss: worker.lastRssBytes,
      });
      await result;
    }
    expect(worker.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(pool.workers).toHaveLength(0);
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
    expect(reservation.release).not.toHaveBeenCalled();
    worker.child.emit("close", 0, "SIGTERM");
    expect(reservation.release).toHaveBeenCalledTimes(1);
    // Ordinary queued work may create a worker under ordinary admission.
    void pool.encodeQuery("ordinary").catch(() => {});
    expect(childProcess.fork).toHaveBeenCalledTimes(2);
  });
  it("existing admission refuses pressure and rechecks quarantine after sampling", async () => {
    pool = new WorkerPool();
    pool.workers[0].queryReady = true;
    vi.mocked(resourceBudget.checkExisting).mockImplementationOnce(() => {
      throw new Error("unknown host");
    });
    await expect(pool.encodeQueryExisting("pressure")).rejects.toThrow(
      "host_pressure",
    );
    vi.mocked(resourceBudget.checkExisting).mockImplementationOnce(() => {
      h.quarantine = "changed";
      return null;
    });
    await expect(pool.encodeQueryExisting("race")).rejects.toThrow(
      "host_pressure",
    );
    expect(h.children[0].send).not.toHaveBeenCalled();
    expect(h.latch).not.toHaveBeenCalled();
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
  });
  it("existing readiness can disappear during admission without spawning", async () => {
    pool = new WorkerPool();
    pool.workers[0].queryReady = true;
    vi.mocked(resourceBudget.checkExisting).mockImplementationOnce(() => {
      pool.workers[0].queryReady = false;
      return null;
    });
    await expect(pool.encodeQueryExisting("race")).rejects.toThrow(
      "embedding_unavailable",
    );
    expect(childProcess.fork).toHaveBeenCalledTimes(1);
  });
});
