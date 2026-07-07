import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake child processes so the pool never forks a real ONNX worker. Shared
// state lives in a hoisted block because vi.mock factories are hoisted above
// imports.
const h = vi.hoisted(() => {
  return { children: [] as any[], nextPid: { v: 1000 } };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    fork: vi.fn(() => {
      const child: any = new EventEmitter();
      child.pid = h.nextPid.v++;
      child.connected = true;
      child.send = vi.fn();
      // SIGKILL on a real child triggers an 'exit' event; mirror that so the
      // pool's exit handler runs exactly as in production.
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
        return true;
      });
      h.children.push(child);
      return child;
    }),
  };
});

// tests/setup.ts mocks the whole pool module to avoid spawning real workers;
// this suite tests the real pool (with child_process faked above), so undo it.
vi.unmock("../src/lib/workers/pool");

import { WorkerPool } from "../src/lib/workers/pool";

describe("WorkerPool resilience", () => {
  let pool: any;

  beforeEach(() => {
    h.children.length = 0;
    h.nextPid.v = 1000;
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (pool && !pool.destroyed) {
      // Mark destroyed first so timers/respawns stop, then best-effort cleanup.
      pool.destroyed = true;
    }
    if (pool?.idleReapInterval) clearInterval(pool.idleReapInterval);
    pool = null;
  });

  it("loads the source worker through an absolute tsx preload", () => {
    pool = new WorkerPool();

    const fork = vi.mocked(childProcess.fork);
    const options = fork.mock.calls[0]?.[1] as
      | { execArgv?: string[] }
      | undefined;

    expect(options?.execArgv).toEqual(
      expect.arrayContaining(["--import", require.resolve("tsx")]),
    );
  });

  it("reapStuckWorkers SIGKILLs a worker wedged in busy=true past the threshold", () => {
    pool = new WorkerPool();
    const worker = pool.workers[0];

    // Simulate the leak: busy with no live task timer (a dropped IPC result),
    // busy since well beyond STUCK_BUSY_MS (HARD_DEADLINE 300s + 60s = 360s).
    worker.busy = true;
    worker.busySince = Date.now() - 7 * 60_000;

    pool.reapStuckWorkers();

    expect(worker.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not reap a worker that has been busy only briefly", () => {
    pool = new WorkerPool();
    const worker = pool.workers[0];

    worker.busy = true;
    worker.busySince = Date.now() - 30_000; // 30s — well under the threshold

    pool.reapStuckWorkers();

    expect(worker.child.kill).not.toHaveBeenCalled();
  });

  it("does not touch an idle worker (busySince null)", () => {
    pool = new WorkerPool();
    const worker = pool.workers[0];

    // Default state after spawn: not busy.
    pool.reapStuckWorkers();

    expect(worker.child.kill).not.toHaveBeenCalled();
  });

  it("recycles an idle worker whose reported RSS exceeds the threshold", () => {
    pool = new WorkerPool();
    // Grow the pool to 3 idle workers so dropping the bloated one is visible.
    pool.spawnWorker();
    pool.spawnWorker();
    const [bloated, lean1, lean2] = pool.workers;

    bloated.busy = false;
    bloated.lastRssBytes = 4096 * 1024 * 1024; // 4 GB, well over the default cap
    lean1.lastRssBytes = 200 * 1024 * 1024;
    lean2.lastRssBytes = 200 * 1024 * 1024;

    pool.reapBloatedWorkers();

    expect(bloated.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(pool.workers).not.toContain(bloated);
    expect(pool.workers).toContain(lean1);
    expect(pool.workers).toContain(lean2);
  });

  it("does not recycle a lean idle worker", () => {
    pool = new WorkerPool();
    pool.spawnWorker();
    for (const w of pool.workers) w.lastRssBytes = 300 * 1024 * 1024;

    pool.reapBloatedWorkers();

    for (const w of pool.workers) {
      expect(w.child.kill).not.toHaveBeenCalled();
    }
  });

  it("recycles a worker bloated across consecutive task completions (continuous-churn path)", () => {
    pool = new WorkerPool();
    pool.spawnWorker();
    const worker = pool.workers[0];

    // Simulate a worker pinned over the threshold but never idle long enough
    // for the timer-based reaper (constant trickle of small tasks).
    worker.busy = false; // just completed a task
    worker.cleanedUp = false;
    worker.lastRssBytes = 4096 * 1024 * 1024;

    // First over-threshold reading is tolerated (could be a transient V8
    // high-water mark); the second confirms the memory is sticky.
    pool.recycleIfBloated(worker);
    expect(worker.child.kill).not.toHaveBeenCalled();

    pool.recycleIfBloated(worker);

    expect(worker.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(pool.workers).not.toContain(worker);
  });

  it("resets the bloat streak when a lean reading intervenes", () => {
    pool = new WorkerPool();
    pool.spawnWorker();
    const worker = pool.workers[0];
    worker.busy = false;
    worker.cleanedUp = false;

    worker.lastRssBytes = 4096 * 1024 * 1024;
    pool.recycleIfBloated(worker); // streak 1

    worker.lastRssBytes = 300 * 1024 * 1024;
    pool.recycleIfBloated(worker); // lean — streak resets

    worker.lastRssBytes = 4096 * 1024 * 1024;
    pool.recycleIfBloated(worker); // streak 1 again — still tolerated

    expect(worker.child.kill).not.toHaveBeenCalled();
    expect(pool.workers).toContain(worker);
  });

  it("does not recycle a bloated worker that is still busy", () => {
    pool = new WorkerPool();
    pool.spawnWorker();
    const worker = pool.workers[0];
    worker.busy = true; // mid-task — must not be interrupted
    worker.lastRssBytes = 4096 * 1024 * 1024;

    pool.reapBloatedWorkers();

    expect(worker.child.kill).not.toHaveBeenCalled();
  });

  it("kills a task at the hard deadline even while heartbeats keep arriving", async () => {
    vi.useFakeTimers();
    pool = new WorkerPool();
    const worker = pool.workers[0];

    const p = pool.processFile({ path: "/huge.ts" } as any);
    p.catch(() => {}); // prevent unhandled rejection warning

    // The task is dispatched synchronously; grab its id from the send call.
    const sent = worker.child.send.mock.calls[0][0];
    expect(sent.method).toBe("processFile");
    const taskId = sent.id;

    // Heartbeat every 100s — under the 120s no-progress timeout, so the soft
    // timeout never fires. Without a hard ceiling this task would run forever.
    for (let elapsed = 0; elapsed < 320_000; elapsed += 100_000) {
      worker.child.emit("message", { id: taskId, heartbeat: true });
      vi.advanceTimersByTime(100_000);
    }

    expect(worker.child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(p).rejects.toThrow(/hard deadline/);
  });

  it("destroy clears force-kill timers when the worker exits after SIGTERM", async () => {
    vi.useFakeTimers();
    pool = new WorkerPool();
    const worker = pool.workers[0];
    worker.child.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") worker.child.emit("exit", null, "SIGTERM");
      return true;
    });

    await pool.destroy();

    expect(worker.child.kill).toHaveBeenCalledWith("SIGTERM");
    worker.child.kill.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.child.kill).not.toHaveBeenCalled();
  });

  it("stops respawning and rejects queued tasks after the timeout respawn cap", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    pool = new WorkerPool();
    pool.maxWorkers = 1;
    pool.consecutiveRespawns = (WorkerPool as any).MAX_RESPAWNS;

    const active = pool.processFile({ path: "/stuck.ts" } as any);
    const queued = pool.processFile({ path: "/queued.ts" } as any);
    const activeCheck = expect(active).rejects.toThrow(/exceeded no progress/);
    const queuedCheck = expect(queued).rejects.toThrow(
      /respawn limit reached/i,
    );

    await vi.advanceTimersByTimeAsync(120_000);

    await activeCheck;
    await queuedCheck;
    expect(h.children).toHaveLength(1);
    expect(pool.workers).toHaveLength(0);
    errorSpy.mockRestore();
  });
});
