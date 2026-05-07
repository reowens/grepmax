import * as fs from "node:fs";
import * as path from "node:path";
import type * as net from "node:net";
import type { DaemonResponse } from "../utils/daemon-client";
import type { Daemon } from "./daemon";
import { debug } from "../utils/logger";

const DAEMON_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf-8")).version;
  } catch {
    return "unknown";
  }
})();

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
    debug("daemon", `ipc cmd=${cmd.cmd}${cmd.root ? ` root=${cmd.root}` : ""}`);
    switch (cmd.cmd) {
      case "ping":
        return { ok: true, pid: process.pid, uptime: daemon.uptime(), version: DAEMON_VERSION };

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
          diskPressure: daemon.getDiskPressure(),
        };

      case "shutdown": {
        const reason = String(cmd.reason ?? "unknown");
        const fromPid = cmd.from_pid ?? "?";
        const fromPpid = cmd.from_ppid ?? "?";
        const fromVer = cmd.from_version ?? "?";
        const fromArgv = Array.isArray(cmd.from_argv) ? cmd.from_argv.join(" ") : "?";
        const fromParentCmd = cmd.from_parent_cmd ?? "?";
        console.log(
          `[daemon] shutdown command received via IPC: reason=${reason} from_pid=${fromPid} from_ppid=${fromPpid} from_version=${fromVer} from_argv=[${fromArgv}] from_parent_cmd=[${fromParentCmd}]`,
        );
        setImmediate(() => daemon.shutdown());
        return { ok: true };
      }

      case "search": {
        const projectRoot = String(cmd.projectRoot || "");
        if (!projectRoot) return { ok: false, error: "missing projectRoot" };
        const query = String(cmd.query || "");
        if (!query) return { ok: false, error: "missing query" };

        // Bind abort to socket close so client ctrl-C cancels the in-flight
        // search instead of letting it run on uselessly.
        const ac = new AbortController();
        const onClose = () => ac.abort();
        conn.on("close", onClose);
        try {
          const limitRaw = typeof cmd.limit === "number" ? cmd.limit : 10;
          const skeletonLimitRaw =
            typeof cmd.skeletonLimit === "number" ? cmd.skeletonLimit : undefined;
          const filters =
            cmd.filters && typeof cmd.filters === "object" && !Array.isArray(cmd.filters)
              ? (cmd.filters as Record<string, string>)
              : undefined;
          const resp = await daemon.search(
            {
              projectRoot,
              query,
              limit: limitRaw,
              filters,
              pathPrefix: typeof cmd.pathPrefix === "string" ? cmd.pathPrefix : undefined,
              rerank: cmd.rerank !== false,
              explain: cmd.explain === true,
              includeSkeletons: cmd.includeSkeletons === true,
              skeletonLimit: skeletonLimitRaw,
              includeGraph: cmd.includeGraph === true,
            },
            ac.signal,
          );
          return resp;
        } finally {
          conn.off("close", onClose);
        }
      }

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
