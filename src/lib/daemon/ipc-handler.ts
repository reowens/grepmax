import * as fs from "node:fs";
import type * as net from "node:net";
import * as path from "node:path";
import type { SearchFilter } from "../store/types";
import type { DaemonResponse } from "../utils/daemon-client";
import { debug } from "../utils/logger";
import {
  OperationBusyError,
  OperationClosedError,
} from "../utils/operation-coordinator";
import { resolveContainedPath } from "../utils/path-containment";
import { listProjects } from "../utils/project-registry";
import type { Daemon } from "./daemon";

const DAEMON_VERSION = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf-8"),
    ).version;
  } catch {
    return "unknown";
  }
})();

export const EXCLUSIVE_GENERATION_REBUILD_PROTOCOL = 1;

/**
 * Write a streaming progress line to the IPC connection.
 */
export function writeProgress(
  conn: net.Socket,
  data: Record<string, unknown>,
): void {
  if (!conn.writable) return;
  conn.write(`${JSON.stringify({ type: "progress", ...data })}\n`);
}

/**
 * Write the final streaming done line and end the connection.
 */
export function writeDone(
  conn: net.Socket,
  data: Record<string, unknown>,
): void {
  if (!conn.writable) return;
  conn.write(`${JSON.stringify({ type: "done", ...data })}\n`);
  conn.end();
}

function errorResponse(err: unknown): DaemonResponse {
  if (
    err instanceof OperationBusyError ||
    err instanceof OperationClosedError
  ) {
    return { ok: false, error: err.message, code: err.code };
  }
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

function startStreaming(
  conn: net.Socket,
  operation: () => Promise<void>,
): void {
  void operation().catch((err) => writeDone(conn, errorResponse(err)));
}

const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Emit periodic heartbeat lines so the client's watchdog timer resets even
 * when no progress is reported (e.g., during a long DB flush or compaction).
 * The client treats heartbeat lines as proof-of-life but not as progress.
 *
 * Returns a stop function; caller MUST call it before writeDone to avoid a
 * stray heartbeat racing the done line.
 */
export function startHeartbeat(
  conn: net.Socket,
  intervalMs = HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    if (!conn.writable) {
      clearInterval(timer);
      return;
    }
    conn.write(`${JSON.stringify({ type: "heartbeat", ts: Date.now() })}\n`);
  }, intervalMs);
  conn.once("close", () => clearInterval(timer));
  return () => clearInterval(timer);
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
    if (
      cmd.cmd !== "ping" &&
      cmd.cmd !== "shutdown" &&
      (daemon.operationStatus() === "closing" ||
        daemon.operationStatus() === "closed")
    ) {
      return errorResponse(new OperationClosedError());
    }
    // The socket listens before LanceDB/MetaCache are open so liveness probes
    // succeed during slow startup. Gate resource-dependent commands until those
    // stores exist; ping/shutdown must always work (probes + restart).
    if (cmd.cmd !== "ping" && cmd.cmd !== "shutdown" && !daemon.isReady()) {
      return { ok: false, error: "daemon initializing" };
    }
    switch (cmd.cmd) {
      case "ping":
        return {
          ok: true,
          ready: daemon.isReady(),
          pid: process.pid,
          uptime: daemon.uptime(),
          version: DAEMON_VERSION,
          operationStatus: daemon.operationStatus(),
          resourceGeneration: daemon.resourceGenerationId(),
          rebuildPending: daemon.hasUnfinishedRebuild(),
          capabilities: {
            exclusiveGenerationRebuild: EXCLUSIVE_GENERATION_REBUILD_PROTOCOL,
          },
        };

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
          mlx: daemon.getMlxStatus(),
        };

      case "project-stats": {
        const root = String(cmd.root || "");
        if (!root) return { ok: false, error: "missing root" };
        const project = listProjects().find((entry) => entry.root === root);
        if (!project) return { ok: false, error: "project not registered" };
        return { ok: true, ...(await daemon.projectStats(root)) };
      }

      case "shutdown": {
        const reason = String(cmd.reason ?? "unknown");
        const fromPid = cmd.from_pid ?? "?";
        const fromPpid = cmd.from_ppid ?? "?";
        const fromVer = cmd.from_version ?? "?";
        const fromArgv = Array.isArray(cmd.from_argv)
          ? cmd.from_argv.join(" ")
          : "?";
        const fromParentCmd = cmd.from_parent_cmd ?? "?";
        console.log(
          `[daemon] shutdown command received via IPC: reason=${reason} from_pid=${fromPid} from_ppid=${fromPpid} from_version=${fromVer} from_argv=[${fromArgv}] from_parent_cmd=[${fromParentCmd}]`,
        );
        setImmediate(() => daemon.shutdown());
        return { ok: true };
      }

      case "search":
      case "search-v2": {
        const isV2 = cmd.cmd === "search-v2";
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
          if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 1000) {
            return { ok: false, error: "invalid limit" };
          }
          const skeletonLimitRaw =
            typeof cmd.skeletonLimit === "number"
              ? cmd.skeletonLimit
              : undefined;
          // Accept both the legacy single-string `exclude` and the new
          // `excludePrefixes`/`inPrefixes` arrays (--in/--exclude on the CLI).
          // Daemon may outlive a CLI restart, so keep both wire shapes for
          // one release; drop the single-string form in v0.17.x.
          const filters =
            cmd.filters &&
            typeof cmd.filters === "object" &&
            !Array.isArray(cmd.filters)
              ? (cmd.filters as SearchFilter)
              : undefined;
          const projectRoots = filters?.projectRoots;
          const eligibleProjects = new Set(
            listProjects()
              .filter((project) => project.status !== "error")
              .map((project) => project.root),
          );
          if (isV2) {
            if (!Array.isArray(projectRoots) || projectRoots.length === 0) {
              return { ok: false, error: "missing projectRoots" };
            }
            if (
              projectRoots.some(
                (root) =>
                  typeof root !== "string" || !eligibleProjects.has(root),
              )
            ) {
              return { ok: false, error: "invalid projectRoots" };
            }
            if (
              filters?.inPrefixes !== undefined ||
              filters?.excludePrefixes !== undefined
            ) {
              return {
                ok: false,
                error:
                  "project path filters are not valid for cross-project search",
              };
            }
          } else if (projectRoots !== undefined) {
            return { ok: false, error: "projectRoots requires search-v2" };
          } else {
            const legacyRoots = filters?.project_roots;
            if (
              typeof legacyRoots === "string" &&
              legacyRoots.split(",").some((root) => !eligibleProjects.has(root))
            ) {
              return { ok: false, error: "invalid project_roots" };
            }
            for (const prefix of [
              ...(filters?.inPrefixes ?? []),
              ...(filters?.excludePrefixes ?? []),
            ]) {
              resolveContainedPath(projectRoot, prefix);
            }
          }

          let pathPrefix: string | undefined;
          if (typeof cmd.pathPrefix === "string") {
            if (isV2) {
              return {
                ok: false,
                error: "pathPrefix is not valid for cross-project search",
              };
            }
            pathPrefix = `${resolveContainedPath(projectRoot, cmd.pathPrefix).replace(/\/$/, "")}/`;
          }
          const resp = await daemon.search(
            {
              projectRoot,
              query,
              limit: limitRaw,
              filters,
              pathPrefix,
              rerank: cmd.rerank === true,
              explain: cmd.explain === true,
              seeds:
                cmd.seeds &&
                typeof cmd.seeds === "object" &&
                !Array.isArray(cmd.seeds)
                  ? (cmd.seeds as { files?: string[]; symbols?: string[] })
                  : undefined,
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
        startStreaming(conn, () => daemon.addProject(root, conn));
        return null;
      }

      case "ensure-project": {
        const root = String(cmd.root || "");
        if (!root) return { ok: false, error: "missing root" };
        startStreaming(conn, () => daemon.ensureProject(root, conn));
        return null;
      }

      case "index": {
        const root = String(cmd.root || "");
        if (!root) return { ok: false, error: "missing root" };
        startStreaming(conn, () =>
          daemon.indexProject(root, conn, {
            reset: !!cmd.reset,
            dryRun: !!cmd.dryRun,
          }),
        );
        return null;
      }

      case "remove": {
        const root = String(cmd.root || "");
        if (!root) return { ok: false, error: "missing root" };
        startStreaming(conn, () => daemon.removeProject(root, conn));
        return null;
      }

      case "repair":
        return {
          ok: false,
          error:
            "legacy repair protocol is disabled; restart gmax and use repair-v2",
          code: "REBUILD_PROTOCOL_REQUIRED",
        };

      case "repair-v2": {
        if (cmd.protocol !== EXCLUSIVE_GENERATION_REBUILD_PROTOCOL) {
          return {
            ok: false,
            error: "unsupported exclusive rebuild protocol",
            code: "REBUILD_PROTOCOL_REQUIRED",
          };
        }
        // Global drop-and-rebuild recovery for a physical table-width mismatch.
        // Streams per-project progress; daemon manages the connection.
        startStreaming(conn, () => daemon.repairRebuild(conn));
        return null;
      }

      case "summarize": {
        const root = String(cmd.root || "");
        if (!root) return { ok: false, error: "missing root" };
        startStreaming(conn, () =>
          daemon.summarizeProject(root, conn, {
            limit: typeof cmd.limit === "number" ? cmd.limit : undefined,
            pathPrefix:
              typeof cmd.pathPrefix === "string" ? cmd.pathPrefix : undefined,
          }),
        );
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
    return errorResponse(err);
  }
}
