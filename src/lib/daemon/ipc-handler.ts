import type { DaemonResponse } from "../utils/daemon-client";
import type { Daemon } from "./daemon";

export async function handleCommand(
  daemon: Daemon,
  cmd: Record<string, unknown>,
): Promise<DaemonResponse> {
  try {
    switch (cmd.cmd) {
      case "ping":
        return { ok: true, pid: process.pid, uptime: daemon.uptime() };

      case "watch": {
        const root = String(cmd.root || "");
        if (!root) return { ok: false, error: "missing root" };
        await daemon.watchProject(root);
        return { ok: true, pid: process.pid };
      }

      case "unwatch": {
        const root = String(cmd.root || "");
        if (!root) return { ok: false, error: "missing root" };
        await daemon.unwatchProject(root);
        return { ok: true };
      }

      case "status":
        return {
          ok: true,
          pid: process.pid,
          uptime: daemon.uptime(),
          projects: daemon.listProjects(),
        };

      case "shutdown":
        // Respond before shutting down so the client gets the response
        setImmediate(() => daemon.shutdown());
        return { ok: true };

      default:
        return { ok: false, error: `unknown command: ${cmd.cmd}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
