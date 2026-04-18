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
      finish({ ok: false, error: (err as NodeJS.ErrnoException).code ?? err.message });
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
export async function isDaemonRunning(opts?: { timeoutMs?: number }): Promise<boolean> {
  const resp = await sendDaemonCommand({ cmd: "ping" }, { timeoutMs: opts?.timeoutMs ?? 2000 });
  return resp.ok === true;
}

/**
 * Lock-file-based liveness probe. A running daemon refreshes daemon.lock's
 * mtime every 60s via its heartbeat loop; a fresh mtime means the daemon is
 * alive even if its socket ping times out under load.
 */
export function isDaemonHeartbeatFresh(): boolean {
  try {
    const stats = fs.statSync(PATHS.daemonLockFile);
    return Date.now() - stats.mtimeMs < HEARTBEAT_FRESH_THRESHOLD_MS;
  } catch {
    return false;
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
          }
        } catch {
          console.warn("[daemon-client] Malformed response line:", line.slice(0, 200));
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
