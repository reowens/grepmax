import { execSync } from "node:child_process";
import {
  isDaemonHeartbeatFresh,
  isDaemonRunning,
} from "../utils/daemon-client";
import { log as dlog } from "../utils/logger";
import { killProcess } from "../utils/process";
import { getWorkerPool, isWorkerPoolInitialized } from "../workers/pool";

/**
 * OS-level process hygiene for the daemon: discovering processes by title,
 * sweeping orphaned workers, and killing stale daemons/workers at startup.
 *
 * Extracted from daemon.ts (Phase 2). Holds no daemon state beyond its own
 * orphan-suspicion set and a shutting-down getter — the lowest-coupling of the
 * three managers.
 */
export class ProcessManager {
  // PIDs flagged as orphan workers on the previous sweep. A worker must look
  // orphaned twice in a row before we kill it, so a worker the pool forked
  // between our process snapshot and its array update is never killed by a race.
  private suspectedOrphanWorkers = new Set<number>();

  constructor(private readonly deps: { getShuttingDown: () => boolean }) {}

  /**
   * Kill gmax-worker processes that are children of THIS daemon but the worker
   * pool no longer tracks — strays left behind if a kill ever failed silently.
   * Filters by parent PID so a per-project `gmax watch`'s own workers are never
   * touched. Requires a worker to look orphaned on two consecutive sweeps so a
   * just-forked worker can't be killed by a snapshot race.
   */
  sweepOrphanWorkers(): void {
    if (this.deps.getShuttingDown() || !isWorkerPoolInitialized()) return;
    const tracked = new Set(getWorkerPool().getWorkerPids());
    const workerPids = new Set(this.findProcessesByTitle("gmax-worker"));
    const ourChildren = this.findChildPids();
    const orphans = ourChildren.filter(
      (pid) => workerPids.has(pid) && !tracked.has(pid),
    );

    const confirmed = orphans.filter((pid) =>
      this.suspectedOrphanWorkers.has(pid),
    );
    this.suspectedOrphanWorkers = new Set(orphans);

    for (const pid of confirmed) {
      console.log(
        `[daemon] Killing orphan worker PID:${pid} (untracked by pool)`,
      );
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      this.suspectedOrphanWorkers.delete(pid);
    }
  }

  /** Child PIDs of this process (workers, MLX, llama-server). */
  findChildPids(): number[] {
    try {
      const out = execSync(`pgrep -P ${process.pid}`, {
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
      if (!out) return [];
      return out
        .split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      return [];
    }
  }

  /**
   * Find and kill all stale gmax-daemon and gmax-worker processes.
   * Uses pgrep to scan by process title rather than relying solely on
   * the PID file, which becomes stale when a daemon is orphaned through
   * the lock-compromise path.
   */
  async killStaleProcesses(): Promise<void> {
    // 1. Check for other daemon processes
    const daemonPids = this.findProcessesByTitle("gmax-daemon").filter(
      (pid) => pid !== process.pid,
    );
    const workerPids = this.findProcessesByTitle("gmax-worker");

    if (daemonPids.length === 0 && workerPids.length === 0) {
      dlog("daemon", "No stale processes found");
      return;
    }

    for (const pid of daemonPids) {
      dlog("daemon", `found daemon PID:${pid}, checking liveness...`);

      // A busy daemon (mid-index, compaction, big LMDB write) can block the
      // event loop long enough to miss a ping. Two independent liveness
      // probes — if either says "alive", defer to the running peer instead
      // of killing its workers mid-flight.
      //   1. daemon.lock mtime (refreshed by heartbeat every 60s)
      //   2. socket ping with a generous 10s timeout
      const heartbeatFresh = isDaemonHeartbeatFresh();
      const responsive = await isDaemonRunning({ timeoutMs: 10_000 });

      if (heartbeatFresh || responsive) {
        dlog(
          "daemon",
          `existing daemon PID:${pid} is alive (heartbeat=${heartbeatFresh} ping=${responsive}) — exiting`,
        );
        process.exit(0);
      }
      dlog(
        "daemon",
        `stale daemon PID:${pid} unresponsive and heartbeat stale — killing`,
      );
      await killProcess(pid);
      dlog("daemon", `killed stale daemon PID:${pid}`);
    }

    // 2. Kill orphaned workers from previous daemon instances.
    // Safe because this runs before the new daemon's worker pool is initialized.
    for (const pid of workerPids) {
      dlog("daemon", `killing orphaned worker PID:${pid}`);
      await killProcess(pid);
    }

    dlog(
      "daemon",
      `Cleaned up ${daemonPids.length} stale daemon(s), ${workerPids.length} orphaned worker(s)`,
    );
  }

  findProcessesByTitle(title: string): number[] {
    try {
      const out = execSync(`pgrep -x "${title}"`, {
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
      if (!out) return [];
      return out
        .split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      // pgrep exits 1 when no processes match — not an error
      return [];
    }
  }
}
