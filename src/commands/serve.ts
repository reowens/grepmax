import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { Command } from "commander";
import { PATHS } from "../config";
import { readIndexConfig } from "../lib/index/index-config";
import { ensureGrammars } from "../lib/index/grammar-loader";
import { createIndexingSpinner } from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import { Searcher } from "../lib/search/searcher";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  getServerForProject,
  isProcessRunning,
  listServers,
  registerServer,
  unregisterServer,
} from "../lib/utils/server-registry";

function isMlxServerUp(): Promise<boolean> {
  const port = parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/health", timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function startMlxServer(mlxModel?: string): ChildProcess | null {
  // Look for mlx-embed-server relative to the osgrep package
  const candidates = [
    path.resolve(__dirname, "../../mlx-embed-server"),
    path.resolve(__dirname, "../mlx-embed-server"),
  ];
  const serverDir = candidates.find((d) => fs.existsSync(path.join(d, "server.py")));
  if (!serverDir) return null;

  const logPath = "/tmp/mlx-embed-server.log";
  const out = fs.openSync(logPath, "a");
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (mlxModel) {
    env.MLX_EMBED_MODEL = mlxModel;
  }
  const child = spawn("uv", ["run", "python", "server.py"], {
    cwd: serverDir,
    detached: true,
    stdio: ["ignore", out, out],
    env,
  });
  child.unref();
  return child;
}

export const serve = new Command("serve")
  .description("Run osgrep as a background server with live indexing")
  .option(
    "-p, --port <port>",
    "Port to listen on",
    process.env.OSGREP_PORT || "4444",
  )
  .option("-b, --background", "Run in background", false)
  .option("--cpu", "Use CPU-only embeddings (skip MLX GPU server)", false)
  .action(async (_args, cmd) => {
    const options: { port: string; background: boolean; cpu: boolean } =
      cmd.optsWithGlobals();
    let port = parseInt(options.port, 10);
    const startPort = port;
    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();

    // Check if already running
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
      const logDir = path.join(PATHS.globalRoot, "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, "server.log");
      const out = fs.openSync(logFile, "a");
      const err = fs.openSync(logFile, "a");

      const child = spawn(process.argv[0], [process.argv[1], ...args], {
        detached: true,
        stdio: ["ignore", out, err],
        cwd: process.cwd(),
        env: { ...process.env, OSGREP_BACKGROUND: "true" },
      });
      child.unref();
      console.log(`Started background server (PID: ${child.pid})`);
      return;
    }

    const paths = ensureProjectPaths(projectRoot);

    // Propagate project root to worker processes
    process.env.OSGREP_PROJECT_ROOT = projectRoot;

    // Determine embed mode: --cpu flag overrides, then config, then default to cpu
    const indexConfig = readIndexConfig(paths.configPath);
    const useGpu = options.cpu
      ? false
      : indexConfig?.embedMode === "gpu";
    const mlxModel = indexConfig?.mlxModel;

    // MLX GPU embed server — started when GPU mode is active.
    let mlxChild: ChildProcess | null = null;
    if (!useGpu) {
      console.log("[serve] CPU-only mode");
    } else {
      const mlxUp = await isMlxServerUp();
      if (mlxUp) {
        console.log("[serve] MLX GPU server already running");
      } else {
        mlxChild = startMlxServer(mlxModel);
        if (mlxChild) {
          console.log(`[serve] Starting MLX GPU embed server (PID: ${mlxChild.pid})${mlxModel ? ` [${mlxModel}]` : ""}`);
          let ready = false;
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            if (await isMlxServerUp()) {
              console.log("[serve] MLX GPU server ready");
              ready = true;
              break;
            }
          }
          if (!ready) {
            console.error("[serve] MLX GPU server failed to start. Run with --cpu to use CPU embeddings.");
            process.exitCode = 1;
            return;
          }
        } else {
          console.error("[serve] MLX server not found. Run with --cpu to use CPU embeddings.");
          process.exitCode = 1;
          return;
        }
      }
    }

    try {
      await ensureSetup();
      await ensureGrammars(console.log, { silent: true });

      const vectorDb = new VectorDB(paths.lancedbDir);
      const searcher = new Searcher(vectorDb);

      // Only show spinner if not in background (or check isTTY)
      // If spawned in background with stdio ignore, console.log goes nowhere.
      // But we might want to log to a file in the future.

      if (!process.env.OSGREP_BACKGROUND) {
        const { spinner, onProgress } = createIndexingSpinner(
          projectRoot,
          "Indexing before starting server...",
        );
        try {
          await initialSync({
            projectRoot,
            onProgress,
          });
          await vectorDb.createFTSIndex();
          spinner.succeed("Initial index ready. Starting server...");
        } catch (e) {
          spinner.fail("Indexing failed");
          throw e;
        }
      } else {
        // In background, just sync quietly
        await initialSync({ projectRoot });
        await vectorDb.createFTSIndex();
      }

      // Idle timeout: shut down if no searches for 30 minutes
      const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
      let lastActivity = Date.now();
      const idleCheck = setInterval(() => {
        if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
          console.log("[serve] Idle timeout reached, shutting down.");
          clearInterval(idleCheck);
          process.kill(process.pid, "SIGTERM");
        }
      }, 60_000);
      idleCheck.unref();

      const server = http.createServer(async (req, res) => {
        try {
          if (req.method === "GET" && req.url === "/health") {
            lastActivity = Date.now();
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }

          if (req.method === "GET" && req.url === "/stats") {
            try {
              const dbStats = await vectorDb.getStats();
              const cfg = readIndexConfig(paths.configPath);
              const stats = {
                files: dbStats.chunks > 0
                  ? (await vectorDb.getDistinctFileCount())
                  : 0,
                chunks: dbStats.chunks,
                totalBytes: dbStats.totalBytes,
                vectorDim: cfg?.vectorDim ?? null,
                embedMode: cfg?.embedMode ?? "cpu",
                model: cfg?.embedModel ?? null,
                mlxModel: cfg?.mlxModel ?? null,
                indexedAt: cfg?.indexedAt ?? null,
              };
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(stats));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: (err as Error)?.message || "stats_failed" }));
            }
            return;
          }

          if (req.method === "POST" && req.url === "/search") {
            lastActivity = Date.now();
            const chunks: Buffer[] = [];
            let totalSize = 0;
            let aborted = false;

            req.on("data", (chunk) => {
              if (aborted) return;
              totalSize += chunk.length;
              if (totalSize > 1_000_000) {
                aborted = true;
                res.statusCode = 413;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "payload_too_large" }));
                req.destroy();
                return;
              }
              chunks.push(chunk);
            });

            req.on("end", async () => {
              if (aborted) return;
              try {
                const body = chunks.length
                  ? JSON.parse(Buffer.concat(chunks).toString("utf-8"))
                  : {};
                const query = typeof body.query === "string" ? body.query : "";
                const limit = typeof body.limit === "number" ? body.limit : 10;

                let searchPath = "";
                if (typeof body.path === "string") {
                  const resolvedPath = path.resolve(projectRoot, body.path);
                  const rootPrefix = projectRoot.endsWith(path.sep)
                    ? projectRoot
                    : `${projectRoot}${path.sep}`;

                  // Normalize paths for consistency (Windows/Linux)
                  const normalizedRootPrefix = path.normalize(rootPrefix);
                  const normalizedResolvedPath = path.normalize(resolvedPath);

                  if (
                    normalizedResolvedPath !== projectRoot &&
                    !normalizedResolvedPath.startsWith(normalizedRootPrefix)
                  ) {
                    res.statusCode = 400;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ error: "invalid_path" }));
                    return;
                  }
                  searchPath = path.relative(projectRoot, resolvedPath);
                }

                // Add AbortController for cancellation
                const ac = new AbortController();
                req.on("close", () => {
                  if (req.complete) return;
                  ac.abort();
                });
                res.on("close", () => {
                  if (res.writableFinished) return;
                  ac.abort();
                });

                const result = await searcher.search(
                  query,
                  limit,
                  { rerank: true },
                  undefined,
                  searchPath,
                  undefined, // intent
                  ac.signal,
                );

                if (ac.signal.aborted) {
                  // Request was cancelled, don't write response if possible
                  // (Though usually 'close' means the socket is gone anyway)
                  return;
                }

                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ results: result.data }));
              } catch (err) {
                if (err instanceof Error && err.name === "AbortError") {
                  // Request cancelled
                  return;
                }
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    error: (err as Error)?.message || "search_failed",
                  }),
                );
              }
            });

            req.on("error", (err) => {
              console.error("[serve] request error:", err);
              aborted = true;
            });

            return;
          }

          res.statusCode = 404;
          res.end();
        } catch (err) {
          console.error("[serve] request handler error:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "internal_error" }));
          }
        }
      });

      server.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE") {
          const nextPort = port + 1;
          if (nextPort < startPort + 10) {
            console.log(`Port ${port} in use, retrying with ${nextPort}...`);
            port = nextPort;
            server.close(() => {
              server.listen(port);
            });
            return;
          }
          console.error(
            `Could not find an open port between ${startPort} and ${startPort + 9}`,
          );
        }
        console.error("[serve] server error:", e);
        // Ensure we exit if server fails to start
        process.exit(1);
      });

      server.listen(port, () => {
        const address = server.address();
        const actualPort =
          typeof address === "object" && address ? address.port : port;

        if (!process.env.OSGREP_BACKGROUND) {
          console.log(
            `osgrep server listening on http://localhost:${actualPort} (${projectRoot})`,
          );
        }
        registerServer({
          pid: process.pid,
          port: actualPort,
          projectRoot,
          startTime: Date.now(),
        });
      });

      const shutdown = async () => {
        unregisterServer(process.pid);

        // Stop MLX server if we started it
        if (mlxChild?.pid) {
          try { process.kill(mlxChild.pid, "SIGTERM"); } catch {}
        }

        // Properly await server close
        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              console.error("Error closing server:", err);
              reject(err);
            } else {
              resolve();
            }
          });
          // Timeout fallback in case close hangs
          setTimeout(resolve, 5000);
        });

        // Clean close of vectorDB
        try {
          await vectorDb.close();
        } catch (e) {
          console.error("Error closing vector DB:", e);
        }
        await gracefulExit();
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Serve failed:", message);
      process.exitCode = 1;
      await gracefulExit(1);
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
    servers.forEach((s) => {
      console.log(`- PID: ${s.pid} | Port: ${s.port} | Root: ${s.projectRoot}`);
    });
  });

serve
  .command("stop")
  .description("Stop background servers")
  .option("--all", "Stop all servers", false)
  .action((options) => {
    if (options.all) {
      const servers = listServers();
      let count = 0;
      servers.forEach((s) => {
        try {
          process.kill(s.pid, "SIGTERM");
          count++;
        } catch (e) {
          console.error(`Failed to stop PID ${s.pid}:`, e);
        }
      });
      console.log(`Stopped ${count} servers.`);
    } else {
      const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
      const server = getServerForProject(projectRoot);
      if (server) {
        try {
          process.kill(server.pid, "SIGTERM");
          console.log(`Stopped server for ${projectRoot} (PID: ${server.pid})`);
        } catch (e) {
          console.error(`Failed to stop PID ${server.pid}:`, e);
        }
      } else {
        console.log(`No server found for ${projectRoot}`);
      }
    }
  });
