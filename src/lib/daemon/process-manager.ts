import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { PATHS } from "../../config";
import { isDaemonDraining, waitForDaemonDrain } from "../utils/daemon-client";

/**
 * Home-local startup arbitration and cleanup of this daemon's own child workers.
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

  constructor(
    private readonly deps: {
      getShuttingDown: () => boolean;
      getWorkerPids?: () => number[] | undefined;
    },
  ) {}

  /**
   * Kill gmax-worker processes that are children of THIS daemon but the worker
   * pool no longer tracks — strays left behind if a kill ever failed silently.
   * Filters by parent PID so a per-project `gmax watch`'s own workers are never
   * touched. Requires a worker to look orphaned on two consecutive sweeps so a
   * just-forked worker can't be killed by a snapshot race.
   */
  sweepOrphanWorkers(): void {
    if (this.deps.getShuttingDown()) return;
    const trackedPids = this.deps.getWorkerPids?.();
    if (!trackedPids) return;
    const tracked = new Set(trackedPids);
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

  /** Home-local arbitration only. Neither a PID nor a title permits termination. */
  async assertStartupAvailable(): Promise<void> {
    for (const [file, json] of [
      [PATHS.daemonPidFile, false],
      [PATHS.daemonDrainingFile, true],
    ] as const) {
      let pid: number;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error("not a regular marker");
        const text = fs.readFileSync(file, "utf8").trim();
        pid = json
          ? JSON.parse(text).pid
          : /^\d+$/.test(text)
            ? Number(text)
            : NaN;
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error("invalid PID");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(`Cannot verify daemon marker ${file}; startup refused`);
      }
      if (pid === process.pid) continue;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
        throw new Error(`Cannot verify daemon PID ${pid}; startup refused`);
      }
      if (isDaemonDraining(pid) && (await waitForDaemonDrain(pid))) continue;
      throw new Error(
        `Daemon PID ${pid} still exists for this Gmax home; startup refused. Request shutdown through its socket and wait for exit.`,
      );
    }
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
