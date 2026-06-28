import * as fs from "node:fs";
import * as net from "node:net";
import { PATHS } from "../../config";

export interface DaemonResponse {
  ok: boolean;
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 5000;

// A live daemon refreshes daemon.lock mtime every 60s (HEARTBEAT_INTERVAL_MS).
// Treat mtime younger than 2.5x that as proof of life, even if a ping times
// out — a busy daemon with a blocked event loop can still be heartbeating.
const HEARTBEAT_FRESH_THRESHOLD_MS = 150_000;

/**
 * Send a JSON command to the daemon over the Unix domain socket.
 * Returns the parsed response, or {ok: false, error} on failure.
 */
export function sendDaemonCommand(
  cmd: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<DaemonResponse> {
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (resp: DaemonResponse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(resp);
    };

    const socket = net.createConnection({ path: PATHS.daemonSocket });

    const timer = setTimeout(() => {
      finish({ ok: false, error: "timeout" });
    }, timeout);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(cmd)}\n`);
    });

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        try {
          finish(JSON.parse(buf.slice(0, nl)));
        } catch {
          finish({ ok: false, error: "invalid response" });
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        error: (err as NodeJS.ErrnoException).code ?? err.message,
      });
    });

    socket.on("close", () => {
      clearTimeout(timer);
      if (!settled) {
        finish({ ok: false, error: "connection closed" });
      }
    });
  });
}

/**
 * Check if the daemon is running by sending a ping. Pass a larger timeoutMs
 * when a busy daemon is plausible (e.g. before killing what might be a live
 * peer) — the default 2s is tight enough that a daemon blocking the event
 * loop mid-index can miss it.
 */
export async function isDaemonRunning(opts?: {
  timeoutMs?: number;
}): Promise<boolean> {
  const resp = await sendDaemonCommand(
    { cmd: "ping" },
    { timeoutMs: opts?.timeoutMs ?? 2000 },
  );
  return resp.ok === true;
}

/**
 * Lock-file-based liveness probe. A running daemon refreshes daemon.lock's
 * mtime every 60s via its heartbeat loop; a fresh mtime means the daemon is
 * alive even if its socket ping times out under load.
 *
 * A fresh mtime alone is not proof of life — a SIGKILL'd (or OOM-killed,
 * panicked, power-lost) daemon leaves the lock file behind with its last
 * heartbeat mtime, fooling this check for up to HEARTBEAT_FRESH_THRESHOLD_MS.
 * Cross-check that the PID file points at an actually-running process.
 */
export function isDaemonHeartbeatFresh(): boolean {
  try {
    const stats = fs.statSync(PATHS.daemonLockFile);
    if (Date.now() - stats.mtimeMs >= HEARTBEAT_FRESH_THRESHOLD_MS)
      return false;
    const pidRaw = fs.readFileSync(PATHS.daemonPidFile, "utf-8").trim();
    const pid = parseInt(pidRaw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/** Read the daemon's PID from the PID file, or null if absent/invalid. */
export function readDaemonPid(): number | null {
  try {
    const pid = parseInt(
      fs.readFileSync(PATHS.daemonPidFile, "utf-8").trim(),
      10,
    );
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Poll until a process has fully exited, or the timeout elapses. Used before
 * spawning a successor daemon: shutdown() drops the socket/lock immediately but
 * keeps draining in-flight work, and a successor that starts in that window
 * classifies the still-draining predecessor as stale and SIGKILLs it. Waiting
 * for the actual process exit closes that race. Returns true if it exited.
 */
export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH — process is gone
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// A daemon's graceful shutdown can run well past the 20s restart wait — worker
// SIGTERM→SIGKILL escalation (5s), maintenance drain (10s), LanceDB close (5s),
// LLM/MLX teardown. Treat a draining marker as authoritative for this long; past
// it, assume the draining daemon wedged and let killStaleProcesses reclaim it.
const DRAIN_GRACE_MS = 90_000;

/**
 * Record that this daemon (pid) has begun graceful shutdown, so a successor's
 * killStaleProcesses() won't SIGKILL it mid-cleanup after it drops its
 * socket/PID/lock liveness markers. Best-effort; cleared by clearDrainingMarker
 * on a clean exit and otherwise self-expires after DRAIN_GRACE_MS.
 */
export function writeDrainingMarker(pid: number): void {
  try {
    fs.mkdirSync(PATHS.globalRoot, { recursive: true });
    fs.writeFileSync(
      PATHS.daemonDrainingFile,
      JSON.stringify({ pid, ts: Date.now() }),
    );
  } catch {}
}

/** Remove the draining marker (clean end of shutdown). */
export function clearDrainingMarker(): void {
  try {
    fs.unlinkSync(PATHS.daemonDrainingFile);
  } catch {}
}

/**
 * True if `pid` is a daemon currently inside graceful shutdown: a fresh draining
 * marker naming that exact PID, and the process is still alive. A stale marker
 * (older than DRAIN_GRACE_MS), a mismatched PID, or a dead process all read as
 * "not draining" so a wedged or already-exited predecessor is still reclaimable.
 */
export function isDaemonDraining(pid: number): boolean {
  try {
    const { pid: markerPid, ts } = JSON.parse(
      fs.readFileSync(PATHS.daemonDrainingFile, "utf-8"),
    );
    if (markerPid !== pid) return false;
    if (typeof ts !== "number" || Date.now() - ts > DRAIN_GRACE_MS)
      return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false; // process already gone — done draining
    }
  } catch {
    return false; // no marker / unreadable
  }
}

/**
 * Ensure the daemon is running — start it if needed, poll up to 5s.
 * Returns true if daemon is ready, false if it couldn't be started.
 */
export async function ensureDaemonRunning(): Promise<boolean> {
  if (await isDaemonRunning()) return true;

  const { spawnDaemon } = await import("./daemon-launcher");
  const pid = spawnDaemon();
  if (!pid) return false;

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isDaemonRunning()) return true;
  }
  return false;
}

// --- Streaming IPC for long-running commands ---

export interface StreamingProgress {
  type: "progress";
  [key: string]: unknown;
}

export interface StreamingDone {
  type: "done";
  ok: boolean;
  [key: string]: unknown;
}

const DEFAULT_STREAMING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Send a streaming command to the daemon. The daemon streams
 * {type:"progress",...} lines followed by a final {type:"done",...}.
 * The timeout resets on each progress message.
 */
export function sendStreamingCommand(
  cmd: Record<string, unknown>,
  onProgress: (msg: StreamingProgress) => void,
  opts?: { timeoutMs?: number },
): Promise<StreamingDone> {
  const timeout = opts?.timeoutMs ?? DEFAULT_STREAMING_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (result: StreamingDone | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(new Error("streaming command timed out"));
      }, timeout);
    };

    const socket = net.createConnection({ path: PATHS.daemonSocket });
    resetTimer();

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(cmd)}\n`);
    });

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic buffer-split loop
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.type === "done") {
            finish(msg as StreamingDone);
          } else if (msg.type === "progress") {
            resetTimer();
            onProgress(msg as StreamingProgress);
          } else if (msg.type === "heartbeat") {
            // Proof-of-life from a daemon doing slow non-emitting work
            // (DB flush, compaction). Reset the watchdog; do not surface.
            resetTimer();
          }
        } catch {
          console.warn(
            "[daemon-client] Malformed response line:",
            line.slice(0, 200),
          );
        }
      }
    });

    socket.on("error", (err) => {
      finish(new Error((err as NodeJS.ErrnoException).code ?? err.message));
    });

    socket.on("close", () => {
      if (!settled) {
        finish(new Error("connection closed before done"));
      }
    });
  });
}
