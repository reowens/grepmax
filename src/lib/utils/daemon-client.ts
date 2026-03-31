import * as net from "node:net";
import { PATHS } from "../../config";

export interface DaemonResponse {
  ok: boolean;
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 5000;

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
 * Check if the daemon is running by sending a ping.
 */
export async function isDaemonRunning(): Promise<boolean> {
  const resp = await sendDaemonCommand({ cmd: "ping" }, { timeoutMs: 2000 });
  return resp.ok === true;
}
