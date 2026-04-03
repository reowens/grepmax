import type * as net from "node:net";
import type { DaemonResponse } from "../utils/daemon-client";
import type { Daemon } from "./daemon";

/**
 * Write a streaming progress line to the IPC connection.
 */
export function writeProgress(conn: net.Socket, data: Record<string, unknown>): void {
  if (!conn.writable) return;
  conn.write(`${JSON.stringify({ type: "progress", ...data })}\n`);
}

/**
 * Write the final streaming done line and end the connection.
 */
export function writeDone(conn: net.Socket, data: Record<string, unknown>): void {
  if (!conn.writable) return;
  conn.write(`${JSON.stringify({ type: "done", ...data })}\n`);
  conn.end();
}

/**
 * Handle a single IPC command.
 *
 * Returns a DaemonResponse for simple commands (caller writes + closes).
 * Returns null for streaming commands (handler manages connection lifecycle).
 */
export async function handleCommand(
  daemon: Daemon,
  cmd: Record<string, unknown>,
  conn: net.Socket,
): Promise<DaemonResponse | null> {
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

      // --- Streaming commands (daemon manages connection) ---

      case "add": {
        const root = String(cmd.root || "");
        if (!root) return { ok: false, error: "missing root" };
        daemon.addProject(root, conn);
        return null;
      }

      case "index": {
        const root = String(cmd.root || "");
        if (!root) return { ok: false, error: "missing root" };
        daemon.indexProject(root, conn, {
          reset: !!cmd.reset,
          dryRun: !!cmd.dryRun,
        });
        return null;
      }

      case "remove": {
        const root = String(cmd.root || "");
        if (!root) return { ok: false, error: "missing root" };
        daemon.removeProject(root, conn);
        return null;
      }

      case "summarize": {
        const root = String(cmd.root || "");
        if (!root) return { ok: false, error: "missing root" };
        daemon.summarizeProject(root, conn, {
          limit: typeof cmd.limit === "number" ? cmd.limit : undefined,
          pathPrefix: typeof cmd.pathPrefix === "string" ? cmd.pathPrefix : undefined,
        });
        return null;
      }

      // --- LLM server management ---

      case "review": {
        const root = String(cmd.root || "");
        const commitRef = String(cmd.commitRef || "HEAD");
        if (!root) return { ok: false, error: "missing root" };
        setImmediate(() => daemon.reviewCommit(root, commitRef));
        return { ok: true };
      }

      case "llm-start":
        return await daemon.llmStart();

      case "llm-stop":
        return await daemon.llmStop();

      case "llm-status":
        return daemon.llmStatus();

      default:
        return { ok: false, error: `unknown command: ${cmd.cmd}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
