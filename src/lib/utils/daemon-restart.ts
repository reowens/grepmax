import type { DaemonResponse } from "./daemon-client";

/**
 * Stop the running daemon and start a fresh one, in one step. It replaces the
 * two-command `gmax watch stop && gmax watch --daemon -b`, which also works on
 * a same-version install (the `-b` path alone only hands off on a version
 * mismatch).
 *
 * The one promise it keeps is never two daemons: the successor is spawned only
 * after the old process has fully exited. A daemon that will not exit is left
 * running and the restart fails, rather than starting a second writer beside
 * it or killing it mid-cleanup.
 */

export interface RestartDeps {
  ping(timeoutMs: number): Promise<DaemonResponse>;
  status(): Promise<DaemonResponse>;
  requestShutdown(): Promise<DaemonResponse>;
  /** PID from daemon.pid, only when its heartbeat is fresh and it is alive. */
  liveDaemonPidFromFiles(): number | null;
  isAlive(pid: number): boolean;
  terminate(pid: number): void;
  /** Spawn `watch --daemon` detached; resolves to its PID, or null. */
  spawn(): Promise<number | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface RestartOptions {
  exitTimeoutMs?: number;
  readyTimeoutMs?: number;
  pollMs?: number;
}

export interface RestartResult {
  ok: boolean;
  /** The daemon that was stopped, or null when none was running. */
  previousPid: number | null;
  /** How the old daemon was asked to stop. */
  stoppedVia: "ipc" | "sigterm" | null;
  pid: number | null;
  version: string | null;
  /** Worker processes running under the new daemon right now. */
  workers: number | null;
  /** The worker thread count the new daemon runs with. */
  workerThreads: number | null;
  /** True when another caller started the successor in the gap. */
  adopted: boolean;
  readyMs: number | null;
  error?: string;
}

// Matches the daemon's own drain grace (DRAIN_GRACE_MS in daemon-client): a
// graceful shutdown can legitimately run this long on a large index.
const DEFAULT_EXIT_TIMEOUT_MS = 90_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 200;

function pidOf(resp: DaemonResponse): number | null {
  return typeof resp.pid === "number" && resp.pid > 0 ? resp.pid : null;
}

export async function restartDaemon(
  deps: RestartDeps,
  opts: RestartOptions = {},
): Promise<RestartResult> {
  const exitTimeoutMs = opts.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  const result: RestartResult = {
    ok: false,
    previousPid: null,
    stoppedVia: null,
    pid: null,
    version: null,
    workers: null,
    workerThreads: null,
    adopted: false,
    readyMs: null,
  };

  // A busy daemon can miss a short ping while its heartbeat is still fresh;
  // the files catch that case so it is stopped rather than raced.
  const first = await deps.ping(5000);
  const previousPid = first.ok
    ? (pidOf(first) ?? deps.liveDaemonPidFromFiles())
    : deps.liveDaemonPidFromFiles();
  result.previousPid = previousPid;
  if (first.ok && previousPid === null) {
    result.error =
      "a daemon answered but did not name its PID; stop it with `gmax watch stop` first";
    return result;
  }

  if (previousPid !== null) {
    const shutdown = await deps.requestShutdown();
    if (shutdown.ok) {
      result.stoppedVia = "ipc";
    } else if (deps.isAlive(previousPid)) {
      // SIGTERM runs the same graceful shutdown as the IPC verb.
      try {
        deps.terminate(previousPid);
        result.stoppedVia = "sigterm";
      } catch {}
    }

    const deadline = deps.now() + exitTimeoutMs;
    while (deps.isAlive(previousPid)) {
      if (deps.now() >= deadline) {
        result.error = `the daemon (PID ${previousPid}) did not exit within ${Math.round(exitTimeoutMs / 1000)}s; it is still running and no second daemon was started`;
        return result;
      }
      await deps.sleep(pollMs);
    }
  }

  const startedAt = deps.now();

  // Something else (a session hook, an MCP server) may have started a daemon
  // in the gap. Spawning beside it would only lose the lock race, so use it.
  const gap = await deps.ping(2000);
  let spawnedPid: number | null = null;
  if (gap.ok && pidOf(gap) !== previousPid) {
    result.adopted = true;
  } else {
    spawnedPid = await deps.spawn();
    if (spawnedPid === null) {
      result.error = "the new daemon could not be spawned";
      return result;
    }
  }

  const readyBy = startedAt + readyTimeoutMs;
  for (;;) {
    const resp = await deps.ping(2000);
    const pid = pidOf(resp);
    if (resp.ok && pid !== null && pid !== previousPid) {
      if (resp.ready !== false) {
        result.pid = pid;
        result.version = typeof resp.version === "string" ? resp.version : null;
        if (spawnedPid !== null && pid !== spawnedPid) result.adopted = true;
        break;
      }
    } else if (spawnedPid !== null && !resp.ok && !deps.isAlive(spawnedPid)) {
      result.error = `the new daemon (PID ${spawnedPid}) exited during startup; see ~/.gmax/logs/daemon.log`;
      return result;
    }
    if (deps.now() >= readyBy) {
      result.error = `the new daemon did not become ready within ${Math.round(readyTimeoutMs / 1000)}s${spawnedPid !== null ? ` (PID ${spawnedPid})` : ""}`;
      result.pid = spawnedPid;
      return result;
    }
    await deps.sleep(pollMs);
  }
  result.readyMs = deps.now() - startedAt;

  const status = await deps.status();
  if (status.ok) {
    if (typeof status.workers === "number") result.workers = status.workers;
    const threads = status.workerThreads as { value?: unknown } | undefined;
    if (threads && typeof threads.value === "number") {
      result.workerThreads = threads.value;
    }
  }

  result.ok = true;
  return result;
}

export function formatRestartResult(r: RestartResult): string {
  const lines: string[] = [];
  if (r.previousPid !== null) {
    lines.push(`Stopped daemon (PID ${r.previousPid}).`);
  } else if (r.ok || r.pid !== null) {
    lines.push("No daemon was running.");
  }
  if (!r.ok) {
    lines.push(`Restart failed: ${r.error ?? "unknown error"}.`);
    return lines.join("\n");
  }
  const parts = [`PID ${r.pid}`];
  if (r.version) parts.push(`v${r.version}`);
  if (r.workerThreads !== null) parts.push(`${r.workerThreads} worker threads`);
  if (r.workers !== null) {
    parts.push(`${r.workers} worker${r.workers === 1 ? "" : "s"} running`);
  }
  if (r.readyMs !== null)
    parts.push(`ready in ${(r.readyMs / 1000).toFixed(1)}s`);
  lines.push(
    `${r.adopted ? "Daemon already started by another caller" : "Daemon started"} (${parts.join(", ")}).`,
  );
  return lines.join("\n");
}
