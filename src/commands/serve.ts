import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { Command } from "commander";
import { PATHS } from "../config";
import type { SearchFilter } from "../lib/store/types";
import {
  BLOCKED_ROOTS_DESCRIPTION,
  isBlockedProjectRoot,
} from "../lib/utils/blocked-roots";
import type { DaemonResponse } from "../lib/utils/daemon-client";
import {
  ensureDaemonRunning,
  sendDaemonCommand,
  sendStreamingCommand,
} from "../lib/utils/daemon-client";
import { gracefulExit } from "../lib/utils/exit";
import { openRotatedLog } from "../lib/utils/log-rotate";
import {
  PathContainmentError,
  resolveContainedPath,
} from "../lib/utils/path-containment";
import { findProjectRoot } from "../lib/utils/project-root";
import { resolveScope } from "../lib/utils/scope-filter";
import {
  getServerForProject,
  isProcessRunning,
  listServers,
  registerServer,
  unregisterServer,
} from "../lib/utils/server-registry";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1_000_000;
export const MAX_HTTP_SEARCH_LIMIT = 50;

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface ServeHttpDeps {
  search: (
    input: {
      query: string;
      limit: number;
      pathPrefix?: string;
      filters?: SearchFilter;
    },
    signal: AbortSignal,
  ) => Promise<DaemonResponse>;
  stats: (signal: AbortSignal) => Promise<DaemonResponse>;
  onActivity?: () => void;
}

export interface ServeHttpRuntime {
  server: http.Server;
  abortActive: () => void;
}

export function waitForChildSpawn(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      child.on("error", (error) => {
        console.error(`Background server process error: ${error.message}`);
      });
      if (child.pid === undefined) {
        reject(new Error("Background process started without a PID"));
        return;
      }
      resolve(child.pid);
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new HttpRequestError(413, "payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", fail);
    req.on("aborted", () => fail(new HttpRequestError(499, "aborted")));
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const value = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
          : {};
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          reject(new HttpRequestError(400, "invalid_json_object"));
          return;
        }
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new HttpRequestError(400, "invalid_json"));
      }
    });
  });
}

function daemonErrorStatus(error: unknown): number {
  if (error === "busy" || error === "rebuilding") return 503;
  if (error === "project not registered" || error === "project not watched") {
    return 404;
  }
  if (error === "invalid limit" || error === "invalid path") return 400;
  return 500;
}

export function serveRootError(root: string): string | undefined {
  if (!isBlockedProjectRoot(root)) return undefined;
  return (
    `Refusing to serve ${root}: this path is blocked from indexing.\n` +
    `(Blocked: ${BLOCKED_ROOTS_DESCRIPTION}.)\n` +
    "Pick a specific project subdirectory instead."
  );
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new HttpRequestError(400, `invalid_${key}`);
  return value;
}

function optionalStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpRequestError(400, `invalid_${key}`);
  }
  return value as string[];
}

export function createServeHttpServer(
  projectRoot: string,
  deps: ServeHttpDeps,
): ServeHttpRuntime {
  const active = new Set<AbortController>();
  const server = http.createServer(async (req, res) => {
    deps.onActivity?.();

    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, { status: "ok" });
      return;
    }

    const ac = new AbortController();
    active.add(ac);
    const abort = () => ac.abort();
    req.once("aborted", abort);
    res.once("close", () => {
      if (!res.writableFinished) abort();
    });

    try {
      if (req.method === "GET" && req.url === "/stats") {
        const response = await deps.stats(ac.signal);
        if (!response.ok) {
          writeJson(res, daemonErrorStatus(response.error), {
            error: response.error ?? "stats_failed",
          });
          return;
        }
        const { ok: _ok, ...stats } = response;
        writeJson(res, 200, stats);
        return;
      }

      if (req.method === "POST" && req.url === "/search") {
        const body = await readJsonBody(req);
        const query = typeof body.query === "string" ? body.query.trim() : "";
        if (!query) throw new HttpRequestError(400, "invalid_query");

        const limit = body.limit === undefined ? 10 : body.limit;
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > MAX_HTTP_SEARCH_LIMIT
        ) {
          throw new HttpRequestError(400, "invalid_limit");
        }

        const requestedPath = optionalString(body, "path");
        const inValues = optionalStringArray(body, "in");
        const excludeValues = optionalStringArray(body, "exclude");
        const scope = resolveScope({
          projectRoot,
          in: inValues?.length
            ? inValues
            : requestedPath
              ? [requestedPath]
              : undefined,
          exclude: excludeValues,
        });
        if (requestedPath) {
          resolveContainedPath(projectRoot, requestedPath, {
            verifyExistingTarget: true,
          });
        }

        const filters: SearchFilter = {};
        const file = optionalString(body, "file");
        const language = optionalString(body, "lang");
        const role = optionalString(body, "role");
        if (file) filters.file = file;
        if (language) filters.language = language;
        if (role) filters.role = role;
        if (scope.inPrefixes.length > 0) filters.inPrefixes = scope.inPrefixes;
        if (scope.excludePrefixes.length > 0) {
          filters.excludePrefixes = scope.excludePrefixes;
        }

        const response = await deps.search(
          {
            query,
            limit,
            pathPrefix: scope.pathPrefix,
            filters: Object.keys(filters).length ? filters : undefined,
          },
          ac.signal,
        );
        if (!response.ok) {
          writeJson(res, daemonErrorStatus(response.error), {
            error: response.error ?? "search_failed",
          });
          return;
        }
        writeJson(res, 200, { results: response.data ?? [] });
        return;
      }

      writeJson(res, 404, { error: "not_found" });
    } catch (err) {
      if (ac.signal.aborted) return;
      if (err instanceof PathContainmentError) {
        writeJson(res, 400, { error: "path_outside_project" });
      } else if (err instanceof HttpRequestError) {
        writeJson(res, err.status, { error: err.code });
      } else {
        writeJson(res, 500, {
          error: err instanceof Error ? err.message : "internal_error",
        });
      }
    } finally {
      active.delete(ac);
    }
  });

  server.setTimeout(60_000);
  return {
    server,
    abortActive: () => {
      for (const ac of active) ac.abort();
      active.clear();
    },
  };
}

export async function listenOnLoopback(
  server: http.Server,
  startPort: number,
  attempts = 10,
): Promise<number> {
  let port = startPort;
  for (let attempt = 0; attempt < attempts; attempt++, port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, LOOPBACK_HOST);
      });
      const address = server.address();
      return typeof address === "object" && address ? address.port : port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(
    `Could not find an open port between ${startPort} and ${startPort + attempts - 1}`,
  );
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 5_000);
    server.close(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export const serve = new Command("serve")
  .description("Loopback HTTP search adapter backed by the gmax daemon")
  .option(
    "-p, --port <port>",
    "Port to listen on",
    process.env.GMAX_PORT || "4444",
  )
  .option("-b, --background", "Run in background", false)
  .option(
    "--cpu",
    "Deprecated: configure daemon CPU mode with gmax config",
    false,
  )
  .option("--no-idle-timeout", "Disable the 30-minute idle shutdown", false)
  .action(async (_args, cmd) => {
    const options: {
      port: string;
      background: boolean;
      cpu: boolean;
      idleTimeout: boolean;
    } = cmd.optsWithGlobals();
    const port = Number.parseInt(options.port, 10);
    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      console.error(`Invalid port: ${options.port}`);
      process.exitCode = 1;
      return;
    }
    const blockedRootError = serveRootError(projectRoot);
    if (blockedRootError) {
      console.error(blockedRootError);
      process.exitCode = 1;
      return;
    }
    if (options.cpu) {
      console.error(
        "--cpu is now configured on the daemon. Run `gmax config --embed-mode cpu`, then start serve again.",
      );
      process.exitCode = 1;
      return;
    }

    const existing = getServerForProject(projectRoot);
    if (existing && isProcessRunning(existing.pid)) {
      console.log(
        `Server already running for ${projectRoot} (PID: ${existing.pid}, Port: ${existing.port})`,
      );
      return;
    }

    if (options.background) {
      const args = process.argv
        .slice(2)
        .filter((arg) => arg !== "-b" && arg !== "--background");
      const safeName = path
        .basename(projectRoot)
        .replace(/[^a-zA-Z0-9._-]/g, "_");
      const logFile = path.join(PATHS.logsDir, `server-${safeName}.log`);
      const out = openRotatedLog(logFile);
      const err = openRotatedLog(logFile);
      try {
        const child = spawn(process.argv[0], [process.argv[1], ...args], {
          detached: true,
          stdio: ["ignore", out, err],
          cwd: process.cwd(),
          env: { ...process.env, GMAX_BACKGROUND: "true" },
        });
        const childPid = await waitForChildSpawn(child);
        child.unref();
        console.log(`Started background server (PID: ${childPid})`);
      } catch (err) {
        console.error(
          `Failed to start background server: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
      }
      return;
    }

    const startupAc = new AbortController();
    let runtime: ServeHttpRuntime | null = null;
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    let registered = false;
    let shutdownPromise: Promise<void> | null = null;

    const shutdown = (code = 0): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        startupAc.abort();
        if (idleTimer) clearInterval(idleTimer);
        runtime?.abortActive();
        if (runtime) await closeServer(runtime.server);
        if (registered) unregisterServer(process.pid);
        await gracefulExit(code);
      })();
      return shutdownPromise;
    };

    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());

    try {
      if (!(await ensureDaemonRunning())) {
        throw new Error("Could not start the gmax daemon");
      }
      const ensured = await sendStreamingCommand(
        { cmd: "ensure-project", root: projectRoot },
        () => {},
        { signal: startupAc.signal },
      );
      if (!ensured.ok) {
        throw new Error(String(ensured.error ?? "project setup failed"));
      }

      let lastActivity = Date.now();
      runtime = createServeHttpServer(projectRoot, {
        onActivity: () => {
          lastActivity = Date.now();
        },
        search: (input, signal) =>
          sendDaemonCommand(
            {
              cmd: "search",
              projectRoot,
              query: input.query,
              limit: input.limit,
              pathPrefix: input.pathPrefix,
              filters: input.filters,
              rerank: true,
            },
            { timeoutMs: 65_000, signal },
          ),
        stats: (signal) =>
          sendDaemonCommand(
            { cmd: "project-stats", root: projectRoot },
            { timeoutMs: 10_000, signal },
          ),
      });

      const actualPort = await listenOnLoopback(runtime.server, port);
      registerServer({
        pid: process.pid,
        port: actualPort,
        projectRoot,
        startTime: Date.now(),
      });
      registered = true;

      if (options.idleTimeout) {
        idleTimer = setInterval(() => {
          if (Date.now() - lastActivity > 30 * 60 * 1000) {
            void shutdown();
          }
        }, 60_000);
        idleTimer.unref();
      }

      runtime.server.on("error", (err) => {
        console.error(
          `[serve:${path.basename(projectRoot)}] server error:`,
          err,
        );
        void shutdown(1);
      });
      if (!process.env.GMAX_BACKGROUND) {
        console.log(
          `gmax server listening on http://${LOOPBACK_HOST}:${actualPort} (${projectRoot})`,
        );
      }
    } catch (err) {
      console.error(
        `Serve failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await shutdown(1);
    }
  });

serve
  .command("status")
  .description("Show status of background servers")
  .action(() => {
    const servers = listServers();
    if (servers.length === 0) {
      console.log("No running servers found.");
      return;
    }
    console.log("Running servers:");
    for (const server of servers) {
      console.log(
        `- PID: ${server.pid} | Port: ${server.port} | Root: ${server.projectRoot}`,
      );
    }
  });

serve
  .command("stop")
  .description("Stop background servers")
  .option("--all", "Stop all servers", false)
  .action((options) => {
    if (options.all) {
      const servers = listServers();
      let count = 0;
      for (const server of servers) {
        try {
          process.kill(server.pid, "SIGTERM");
          count++;
        } catch (err) {
          console.error(`Failed to stop PID ${server.pid}:`, err);
        }
      }
      console.log(`Stopped ${count} servers.`);
      return;
    }

    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
    const server = getServerForProject(projectRoot);
    if (!server) {
      console.log(`No server found for ${projectRoot}`);
      return;
    }
    try {
      process.kill(server.pid, "SIGTERM");
      console.log(`Stopped server for ${projectRoot} (PID: ${server.pid})`);
    } catch (err) {
      console.error(`Failed to stop PID ${server.pid}:`, err);
    }
  });
