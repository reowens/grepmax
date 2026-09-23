import { describe, expect, it } from "vitest";
import { watch } from "../src/commands/watch";
import type { DaemonResponse } from "../src/lib/utils/daemon-client";
import {
  formatRestartResult,
  type RestartDeps,
  restartDaemon,
} from "../src/lib/utils/daemon-restart";

/**
 * A simulated process table and socket. `daemon` is whoever answers the
 * socket; `alive` is every PID that still exists.
 */
function world(opts: {
  daemon?: { pid: number; version?: string } | null;
  heartbeatPid?: number | null;
  shutdownAnswers?: boolean;
  exitsAfterMs?: number | null;
  spawnPid?: number | null;
  readyAfterMs?: number;
  spawnDiesAtStartup?: boolean;
  peerStartsInGap?: number | null;
  status?: DaemonResponse;
}) {
  let clock = 0;
  const alive = new Set<number>();
  let daemon = opts.daemon ?? null;
  if (daemon) alive.add(daemon.pid);
  if (opts.heartbeatPid) alive.add(opts.heartbeatPid);
  let exitAt: number | null = null;
  let exitingPid: number | null = null;
  let spawnedAt: number | null = null;
  let spawned: number | null = null;
  const calls: string[] = [];
  const spawns: number[] = [];

  const tick = () => {
    if (exitingPid !== null && exitAt !== null && clock >= exitAt) {
      alive.delete(exitingPid);
      exitingPid = null;
    }
    if (
      spawned !== null &&
      spawnedAt !== null &&
      !opts.spawnDiesAtStartup &&
      clock >= spawnedAt + (opts.readyAfterMs ?? 0) &&
      daemon === null
    ) {
      daemon = { pid: spawned, version: "9.9.9" };
    }
  };

  const beginExit = (pid: number) => {
    // The socket goes away at once; the process drains.
    if (daemon?.pid === pid) daemon = null;
    if (opts.exitsAfterMs === null) return;
    exitingPid = pid;
    exitAt = clock + (opts.exitsAfterMs ?? 500);
    tick();
  };

  const deps: RestartDeps = {
    async ping() {
      tick();
      calls.push("ping");
      if (
        opts.peerStartsInGap &&
        daemon === null &&
        exitingPid === null &&
        spawned === null &&
        calls.includes("shutdown")
      ) {
        daemon = { pid: opts.peerStartsInGap, version: "9.9.9" };
        alive.add(opts.peerStartsInGap);
      }
      if (!daemon) return { ok: false, error: "ECONNREFUSED" };
      return {
        ok: true,
        pid: daemon.pid,
        version: daemon.version ?? "1.0.0",
        ready: true,
      };
    },
    async status() {
      calls.push("status");
      return (
        opts.status ?? {
          ok: true,
          pid: daemon?.pid,
          workers: 1,
          workerThreads: { value: 4, source: "default" },
        }
      );
    },
    async requestShutdown() {
      calls.push("shutdown");
      if (!daemon || opts.shutdownAnswers === false) {
        return { ok: false, error: "timeout" };
      }
      beginExit(daemon.pid);
      return { ok: true };
    },
    liveDaemonPidFromFiles() {
      if (daemon) return daemon.pid;
      return opts.heartbeatPid ?? null;
    },
    isAlive(pid) {
      tick();
      return alive.has(pid);
    },
    terminate(pid) {
      calls.push(`sigterm:${pid}`);
      beginExit(pid);
    },
    async spawn() {
      calls.push("spawn");
      if (opts.spawnPid === null) return null;
      spawned = opts.spawnPid ?? 200;
      spawnedAt = clock;
      spawns.push(spawned);
      if (!opts.spawnDiesAtStartup) alive.add(spawned);
      tick();
      return spawned;
    },
    async sleep(ms) {
      clock += ms;
      tick();
    },
    now: () => clock,
  };
  return { deps, calls, spawns, alive: () => alive };
}

describe("restartDaemon", () => {
  it("stops the running daemon, waits for it to exit, then starts one", async () => {
    const w = world({ daemon: { pid: 100 }, exitsAfterMs: 1500 });
    const r = await restartDaemon(w.deps, { pollMs: 100 });
    expect(r).toMatchObject({
      ok: true,
      previousPid: 100,
      stoppedVia: "ipc",
      pid: 200,
      version: "9.9.9",
      workers: 1,
      workerThreads: 4,
      adopted: false,
    });
    // The successor is spawned only after the old process is gone.
    const spawnIndex = w.calls.indexOf("spawn");
    expect(spawnIndex).toBeGreaterThan(w.calls.indexOf("shutdown"));
    expect(w.alive().has(100)).toBe(false);
    expect(w.spawns).toEqual([200]);
  });

  it("starts a daemon when none was running", async () => {
    const w = world({ daemon: null });
    const r = await restartDaemon(w.deps, { pollMs: 100 });
    expect(r.ok).toBe(true);
    expect(r.previousPid).toBeNull();
    expect(r.stoppedVia).toBeNull();
    expect(r.pid).toBe(200);
    expect(w.calls).not.toContain("shutdown");
    expect(formatRestartResult(r)).toMatch(/^No daemon was running\./);
  });

  it("never starts a second daemon when the old one will not exit", async () => {
    const w = world({ daemon: { pid: 100 }, exitsAfterMs: null });
    const r = await restartDaemon(w.deps, {
      pollMs: 100,
      exitTimeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not exit within 2s/);
    expect(w.spawns).toEqual([]);
    expect(w.alive().has(100)).toBe(true);
  });

  it("falls back to SIGTERM when the busy daemon cannot answer the shutdown", async () => {
    const w = world({
      daemon: null,
      heartbeatPid: 100,
      exitsAfterMs: 300,
    });
    const r = await restartDaemon(w.deps, { pollMs: 100 });
    expect(r.ok).toBe(true);
    expect(r.previousPid).toBe(100);
    expect(r.stoppedVia).toBe("sigterm");
    expect(w.calls).toContain("sigterm:100");
    expect(w.calls.indexOf("spawn")).toBeGreaterThan(
      w.calls.indexOf("sigterm:100"),
    );
  });

  it("uses a daemon another caller started in the gap instead of spawning", async () => {
    const w = world({
      daemon: { pid: 100 },
      exitsAfterMs: 0,
      peerStartsInGap: 300,
    });
    const r = await restartDaemon(w.deps, { pollMs: 100 });
    expect(r.ok).toBe(true);
    expect(r.adopted).toBe(true);
    expect(r.pid).toBe(300);
    expect(w.spawns).toEqual([]);
  });

  it("reports a successor that dies during startup", async () => {
    const w = world({ daemon: null, spawnDiesAtStartup: true });
    const r = await restartDaemon(w.deps, { pollMs: 100 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exited during startup/);
  });

  it("reports a successor that never becomes ready", async () => {
    const w = world({ daemon: null, readyAfterMs: 10_000 });
    const r = await restartDaemon(w.deps, {
      pollMs: 100,
      readyTimeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.pid).toBe(200);
    expect(r.error).toMatch(/did not become ready within 1s/);
  });

  it("reports a failed spawn", async () => {
    const w = world({ daemon: null, spawnPid: null });
    const r = await restartDaemon(w.deps, { pollMs: 100 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not be spawned/);
  });

  it("leaves worker counts null when the daemon does not report them", async () => {
    const w = world({ daemon: null, status: { ok: true } });
    const r = await restartDaemon(w.deps, { pollMs: 100 });
    expect(r.ok).toBe(true);
    expect(r.workers).toBeNull();
    expect(r.workerThreads).toBeNull();
  });

  it("formats the new PID and worker count", () => {
    const text = formatRestartResult({
      ok: true,
      previousPid: 100,
      stoppedVia: "ipc",
      pid: 200,
      version: "0.26.37",
      workers: 1,
      workerThreads: 4,
      adopted: false,
      readyMs: 3200,
    });
    expect(text).toBe(
      "Stopped daemon (PID 100).\nDaemon started (PID 200, v0.26.37, 4 worker threads, 1 worker running, ready in 3.2s).",
    );
  });
});

describe("gmax watch restart", () => {
  it("is a watch subcommand with --json", () => {
    const restart = watch.commands.find((c) => c.name() === "restart");
    expect(restart).toBeDefined();
    expect(restart?.options.map((o) => o.long)).toContain("--json");
  });
});
