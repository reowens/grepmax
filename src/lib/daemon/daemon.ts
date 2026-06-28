import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { AsyncSubscription } from "@parcel/watcher";
import lockfile from "proper-lockfile";
import { CONFIG, PATHS } from "../../config";
import { ProjectBatchProcessor } from "../index/batch-processor";
import { initialSync, generateSummaries } from "../index/syncer";
import type { Searcher } from "../search/searcher";
import type { IndexState } from "../output/index-state-footer";
import {
  type DaemonSearchPayload,
  type DaemonSearchResult,
  handleDaemonSearch,
} from "./search-handler";
import { MetaCache } from "../store/meta-cache";
import { VectorDB } from "../store/vector-db";
import { killProcess } from "../utils/process";
import {
  getProject,
  listProjects,
  registerProject,
} from "../utils/project-registry";
import {
  heartbeat,
  listWatchers,
  registerDaemon,
  unregisterDaemon,
  unregisterWatcher,
  unregisterWatcherByRoot,
} from "../utils/watcher-store";
import { LlmServer } from "../llm/server";
import {
  handleCommand,
  writeProgress,
  writeDone,
  startHeartbeat,
} from "./ipc-handler";
import { ProcessManager } from "./process-manager";
import { MlxServerManager } from "./mlx-server-manager";
import { WatcherManager } from "./watcher-manager";
import { log as dlog, debug as dbg } from "../utils/logger";
import { readGlobalConfig } from "../index/index-config";
import { rotateLogFds } from "../utils/log-rotate";
import { destroyWorkerPool, isWorkerPoolInitialized } from "../workers/pool";
import { spawnDaemon } from "../utils/daemon-launcher";

// 30 min was too aggressive — every shutdown is a chance for races, FSEvents
// drops, and orphan MLX cleanup. 4 hours keeps the daemon resident through a
// normal workday while still freeing resources overnight. Override with
// GMAX_DAEMON_IDLE_TIMEOUT_MS=<ms>; set to 0 (or negative) to disable.
const DEFAULT_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = (() => {
  const raw = process.env.GMAX_DAEMON_IDLE_TIMEOUT_MS;
  if (raw == null) return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_IDLE_TIMEOUT_MS;
  return parsed; // <= 0 disables the idle check below
})();
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

// Self-recycle. Under continuous load (a busy monorepo) the idle timeout never
// fires, so a long-lived daemon never gets a fresh start. The 24h age trigger
// is the primary hygiene mechanism. The RSS trigger is a backstop for a genuine
// runaway only: the daemon's memory is dominated by LanceDB working set, which
// legitimately spikes to ~1.7 GB during compaction (then frees) on a ~250k-chunk
// store, so the ceiling sits well above that to avoid recycling on normal
// spikes. The maintenance-active guard in maybeRecycle() also defers during
// compaction. Either ceiling <= 0 disables that trigger.
const envNum = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const MAX_LIFETIME_MS = envNum(
  "GMAX_DAEMON_MAX_LIFETIME_MS",
  24 * 60 * 60 * 1000,
);
const RSS_WATERMARK_MB = envNum("GMAX_DAEMON_RSS_WATERMARK_MB", 2560);

export class Daemon {
  private readonly processors = new Map<string, ProjectBatchProcessor>();
  private readonly searchers = new Map<string, Searcher>();
  private readonly subscriptions = new Map<string, AsyncSubscription>();
  private vectorDb: VectorDB | null = null;
  private metaCache: MetaCache | null = null;
  private server: net.Server | null = null;
  private releaseLock: (() => Promise<void>) | null = null;
  private lastActivity = Date.now();
  private readonly startTime = Date.now();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private idleInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTick = 0;
  private shuttingDown = false;
  private recycling = false;
  private readonly processManager = new ProcessManager({
    getShuttingDown: () => this.shuttingDown,
  });
  private readonly mlxServerManager = new MlxServerManager({
    getShuttingDown: () => this.shuttingDown,
  });
  private readonly watcherManager = new WatcherManager({
    processors: this.processors,
    subscriptions: this.subscriptions,
    getVectorDb: () => this.vectorDb,
    getMetaCache: () => this.metaCache,
    getShuttingDown: () => this.shuttingDown,
    touchActivity: () => {
      this.lastActivity = Date.now();
    },
    evictSearcher: (root) => {
      this.searchers.delete(root);
    },
  });
  private readonly projectLocks = new Map<string, Promise<void>>();
  // Full-index progress per root while initialSync runs (--reset / initial
  // index). Presence = a full index is in flight; value drives the partial-
  // result pending count (Phase 6). Cleared in the indexProject finally.
  private readonly indexProgress = new Map<
    string,
    { processed: number; total: number }
  >();
  private readonly shutdownAbortControllers = new Set<AbortController>();
  private llmServer: LlmServer | null = null;

  async start(): Promise<void> {
    process.title = "gmax-daemon";

    // 0. Singleton enforcement: find and kill ALL stale daemon/worker processes
    await this.processManager.killStaleProcesses();

    // 1. Acquire exclusive lock — kernel-enforced, atomic, auto-released on death
    fs.mkdirSync(path.dirname(PATHS.daemonLockFile), { recursive: true });
    fs.writeFileSync(PATHS.daemonLockFile, "", { flag: "a" }); // ensure file exists
    dbg("daemon", "acquiring lock...");
    try {
      this.releaseLock = await lockfile.lock(PATHS.daemonLockFile, {
        retries: 0,
        stale: 120_000,
        onCompromised: () => {
          console.error(
            "[daemon] Lock compromised — another daemon took over. Shutting down.",
          );
          // Force exit after timeout — shutdown() is async and may not fully
          // clear event loop references, leaving zombie daemon processes.
          setTimeout(() => process.exit(1), 10_000).unref();
          this.shutdown().finally(() => process.exit(0));
        },
      });
      dbg("daemon", "lock acquired");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOCKED") {
        console.error("[daemon] Another daemon is already running");
        process.exit(0);
      }
      throw err;
    }

    // 2. Stale socket cleanup + start socket server EARLY.
    // The socket must be listening before the PID file is written so that
    // other daemons checking isDaemonRunning() never see a PID for a process
    // that can't respond to pings. Without this, the slow initialization
    // steps below (LanceDB, MLX, project watchers) create a window where
    // new daemons kill this one as "unresponsive".
    try {
      fs.unlinkSync(PATHS.daemonSocket);
    } catch {}

    this.server = net.createServer((conn) => {
      dbg("daemon", "client connected");
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString();
        if (buf.length > 1_000_000) {
          conn.destroy();
          return;
        }
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let cmd: Record<string, unknown>;
        try {
          cmd = JSON.parse(line);
        } catch {
          conn.write(
            `${JSON.stringify({ ok: false, error: "invalid JSON" })}\n`,
          );
          conn.end();
          return;
        }
        handleCommand(this, cmd, conn).then((resp) => {
          // null means the handler is managing the connection (streaming)
          if (resp !== null) {
            conn.write(`${JSON.stringify(resp)}\n`);
            conn.end();
          }
        });
      });
      conn.on("error", () => {});
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE") {
          console.error("[daemon] Socket already in use");
          reject(err);
        } else if (code === "EOPNOTSUPP") {
          console.error("[daemon] Filesystem does not support Unix sockets");
          process.exitCode = 2;
          reject(err);
        } else {
          reject(err);
        }
      });
      this.server!.listen(PATHS.daemonSocket, () => resolve());
    });

    // 3. Write PID file AFTER socket is listening — ensures any process that
    // reads the PID can immediately ping this daemon and get a response.
    fs.writeFileSync(PATHS.daemonPidFile, String(process.pid));

    // 4. Kill existing per-project watchers
    const existing = listWatchers();
    for (const w of existing) {
      console.log(
        `[daemon] Taking over from per-project watcher (PID: ${w.pid}, ${path.basename(w.projectRoot)})`,
      );
      await killProcess(w.pid);
      unregisterWatcher(w.pid);
    }

    // 5. Open shared resources
    try {
      fs.mkdirSync(PATHS.cacheDir, { recursive: true });
      fs.mkdirSync(PATHS.lancedbDir, { recursive: true });
      console.log("[daemon] Opening LanceDB:", PATHS.lancedbDir);
      this.vectorDb = new VectorDB(PATHS.lancedbDir);
      this.vectorDb.startMaintenanceLoop();
      console.log("[daemon] Opening MetaCache:", PATHS.lmdbPath);
      this.metaCache = new MetaCache(PATHS.lmdbPath);
    } catch (err) {
      console.error("[daemon] Failed to open shared resources:", err);
      throw err;
    }

    // 6. LLM server manager (constructed, not started — starts on first request)
    this.llmServer = new LlmServer();

    // 6b. MLX embed server — start if GPU mode is active
    const globalConfig = readGlobalConfig();
    const isAppleSilicon =
      process.arch === "arm64" && process.platform === "darwin";
    if (isAppleSilicon && globalConfig.embedMode === "gpu") {
      await this.mlxServerManager.ensureMlxServer(globalConfig.mlxModel);
    }

    // 7. Register daemon (only after resources are open)
    registerDaemon(process.pid);

    // 8. Subscribe to all registered projects (skip missing directories)
    const allProjects = listProjects();
    const indexed = allProjects.filter((p) => p.status === "indexed");
    for (const p of indexed) {
      if (!fs.existsSync(p.root)) {
        console.log(
          `[daemon] Skipping ${path.basename(p.root)} — directory not found`,
        );
        continue;
      }
      try {
        await this.watchProject(p.root);
      } catch (err) {
        console.error(
          `[daemon] Failed to watch ${path.basename(p.root)}:`,
          err,
        );
      }
    }

    // 8b. Index pending/error projects in the background, serialized to avoid
    // racing on shared LanceDB table creation (only one ensureTable() may win the
    // first createTable; the rest crash with "Table 'chunks' already exists").
    // Re-check shuttingDown each iteration: shutdown's pendingLocks drain is a
    // snapshot, so a new project op kicked off after the snapshot would race
    // with vectorDb.close() and fail with "VectorDB connection is closed".
    const pending = allProjects.filter(
      (p) =>
        (p.status === "pending" || p.status === "error") &&
        fs.existsSync(p.root),
    );
    void (async () => {
      for (const p of pending) {
        if (this.shuttingDown) return;
        try {
          await this.indexPendingProject(p.root);
        } catch (err) {
          console.error(
            `[daemon] Failed to index pending ${path.basename(p.root)}:`,
            err,
          );
        }
      }
    })();

    // 9. Heartbeat + refresh lockfile mtime to prevent stale detection
    this.heartbeatInterval = setInterval(() => {
      heartbeat(process.pid);
      try {
        const now = new Date();
        fs.utimesSync(PATHS.daemonLockFile, now, now);
      } catch {}
      rotateLogFds(path.join(PATHS.logsDir, "daemon.log"));
      // Every 5 ticks (5 min), probe the MLX embed server and respawn if
      // it's gone zombie (port held but /health unresponsive). Closes the
      // 42h-degradation window where workers silently fell back to ONNX CPU
      // after a frozen MLX process kept the port bound (v0.17.0 bug #1).
      this.heartbeatTick++;
      if (this.heartbeatTick % 5 === 0) {
        void this.mlxServerManager.checkMlxHealth();
        this.processManager.sweepOrphanWorkers();
        this.maybeRecycle();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // 10. Idle timeout (skip when disabled via env)
    if (IDLE_TIMEOUT_MS > 0) {
      this.idleInterval = setInterval(() => {
        if (Date.now() - this.lastActivity <= IDLE_TIMEOUT_MS) return;
        // Don't kick off shutdown on top of a live maintenance pass — let it
        // finish and check again next tick. close() awaits this anyway, but
        // postponing keeps shutdown paths clean and timestamps coherent.
        if (this.vectorDb?.isMaintenanceActive()) return;
        const minutes = Math.round(IDLE_TIMEOUT_MS / 60_000);
        console.log(`[daemon] Idle for ${minutes} minutes, shutting down`);
        this.shutdown();
      }, HEARTBEAT_INTERVAL_MS);
    } else {
      console.log(
        "[daemon] Idle shutdown disabled (GMAX_DAEMON_IDLE_TIMEOUT_MS<=0)",
      );
    }

    console.log(
      `[daemon] Started (PID: ${process.pid}, ${this.processors.size} projects)`,
    );

    // Pre-warm the search hot path so the first user-facing search doesn't
    // pay daemon-side cold costs:
    //   - LanceDB connection open + first openTable() (~10–15s on a 5GB
    //     index — this is the dominant cost)
    //   - FTS index "already exists" round-trip
    //   - Two parallel encodeQuery calls so the worker pool spawns + warms
    //     workers ahead of the first real search. The reaper floor is
    //     MIN_KEEP_WORKERS = 1 (pool.ts), so only one worker stays resident
    //     long-term — but the prewarm still pays the model-load cost up front.
    // Fire-and-forget; failures are non-fatal — the next real search just
    // pays the cost once. Delay a few seconds so we don't compete with the
    // catchup scans dispatched on startup.
    setTimeout(() => {
      if (this.shuttingDown) return;
      void (async () => {
        const t0 = Date.now();
        try {
          if (this.vectorDb) {
            await this.vectorDb.ensureTable();
            await this.vectorDb.createFTSIndex();
          }
          const { getWorkerPool } = await import("../workers/pool");
          const pool = getWorkerPool();
          // Two parallel encodes force the pool to spawn two workers and
          // warm both (each worker loads Granite + ColBERT lazily on first
          // encode — once warmed, subsequent encodes are ~13ms).
          await Promise.all([
            pool.encodeQuery("warmup-a"),
            pool.encodeQuery("warmup-b"),
          ]);
          console.log(
            `[daemon] Search hot path pre-warmed (${Date.now() - t0}ms)`,
          );
        } catch (err) {
          console.log(`[daemon] Search warmup failed (non-fatal): ${err}`);
        }
      })();
    }, 5000).unref();
  }

  async watchProject(root: string): Promise<void> {
    return this.watcherManager.watchProject(root);
  }

  private async indexPendingProject(root: string): Promise<void> {
    await this.withProjectLock(root, async () => {
      // Bail if shutdown raced ahead of us between IIFE iteration and lock
      // acquisition — otherwise we'd start writing to a DB that shutdown is
      // about to close, leaving the project status as "error".
      if (this.shuttingDown) return;
      if (!this.vectorDb || !this.metaCache) return;

      const name = path.basename(root);
      const start = Date.now();
      dlog("daemon", `indexPendingProject start: ${name} (${root})`);
      this.vectorDb.pauseMaintenanceLoop();
      try {
        const result = await initialSync({
          projectRoot: root,
          vectorDb: this.vectorDb,
          metaCache: this.metaCache,
          onProgress: () => {
            this.resetActivity();
          },
        });

        const proj = getProject(root);
        if (proj) {
          registerProject({
            ...proj,
            lastIndexed: new Date().toISOString(),
            chunkCount: result.indexed,
            status: "indexed",
            chunkerVersion: CONFIG.CHUNKER_VERSION,
          });
        }

        await this.watchProject(root);
        dlog(
          "daemon",
          `indexPendingProject done: ${name} — ${result.total} files, ${result.indexed} chunks, ${Date.now() - start}ms`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[daemon] indexPendingProject failed for ${name} after ${Date.now() - start}ms: ${msg}`,
        );
        const proj = getProject(root);
        if (proj) {
          registerProject({ ...proj, status: "error" });
        }
      } finally {
        this.vectorDb?.resumeMaintenanceLoop();
      }
    });
  }

  async unwatchProject(root: string): Promise<void> {
    return this.watcherManager.unwatchProject(root);
  }

  /**
   * Run a search inside the daemon, reusing the warm VectorDB connection,
   * worker pool (with embeddings/ColBERT pre-loaded), and per-project Searcher.
   * The CLI's in-process path costs ~17s wall + 6GB RAM per call; this drops
   * it to <1s by avoiding cold-start.
   *
   * Returns a JSON-serializable response. The IPC handler writes it; the
   * caller is responsible for binding `signal` to socket close so we abort if
   * the client disconnects mid-search.
   */
  /**
   * Live (re)index progress for a project: whether indexing is underway and how
   * many files are still queued. Derived from the batch processor's pending map
   * plus the registry's initial-index status. Cheap (in-memory) — safe to call
   * on every search to annotate partial-result responses (Phase 6).
   */
  indexState(root: string): IndexState {
    const processor = this.processors.get(root);
    const batchPending = processor?.progress.pendingFiles ?? 0;
    const processing = processor?.progress.processing ?? false;
    // status === "pending" means the initial full index hasn't completed.
    const initialPending = getProject(root)?.status === "pending";
    // A full index (--reset / initial) bypasses the batch processor; its
    // onProgress feeds indexProgress, giving a real remaining count.
    const fullIdx = this.indexProgress.get(root);

    let pendingFiles = batchPending;
    if (fullIdx && fullIdx.total > 0) {
      pendingFiles = Math.max(pendingFiles, fullIdx.total - fullIdx.processed);
    }
    return {
      indexing: !!fullIdx || processing || batchPending > 0 || initialPending,
      pendingFiles,
    };
  }

  async search(
    payload: DaemonSearchPayload,
    signal: AbortSignal,
  ): Promise<DaemonSearchResult> {
    // Search handling lives in search-handler.ts (Phase 12 split). The daemon
    // supplies its warm VectorDB + watcher/index bookkeeping; the handler runs
    // the query and assembles the response.
    return handleDaemonSearch(
      {
        vectorDb: this.vectorDb,
        processors: this.processors,
        indexProgress: this.indexProgress,
        searchers: this.searchers,
        getIndexState: (root) => this.indexState(root),
        touchActivity: () => {
          this.lastActivity = Date.now();
        },
      },
      payload,
      signal,
    );
  }

  listProjects(): Array<{ root: string; status: string }> {
    return [...this.processors.keys()].map((root) => ({
      root,
      status: "watching",
    }));
  }

  uptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  getDiskPressure(): string {
    return this.vectorDb?.diskPressure ?? "unknown";
  }

  /** Reset idle timer — call during long-running operations. */
  resetActivity(): void {
    this.lastActivity = Date.now();
  }

  // --- Per-project operation serialization ---

  private async withProjectLock<T>(
    root: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.projectLocks.get(root) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    this.projectLocks.set(root, next);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.projectLocks.get(root) === next) {
        this.projectLocks.delete(root);
      }
    }
  }

  // --- Streaming write operations (IPC) ---

  async addProject(root: string, conn: net.Socket): Promise<void> {
    await this.withProjectLock(root, async () => {
      if (!this.vectorDb || !this.metaCache) {
        writeDone(conn, { ok: false, error: "daemon resources not ready" });
        return;
      }

      const ac = new AbortController();
      conn.on("close", () => ac.abort());
      this.shutdownAbortControllers.add(ac);

      this.vectorDb.pauseMaintenanceLoop();
      const stopHeartbeat = startHeartbeat(conn);
      let lastProgressTime = 0;
      try {
        const result = await initialSync({
          projectRoot: root,
          vectorDb: this.vectorDb,
          metaCache: this.metaCache,
          signal: ac.signal,
          onProgress: (info) => {
            this.resetActivity();
            const now = Date.now();
            if (now - lastProgressTime < 100) return;
            lastProgressTime = now;
            writeProgress(conn, {
              processed: info.processed,
              indexed: info.indexed,
              total: info.total,
              filePath: info.filePath,
            });
          },
        });

        if (!this.shuttingDown) {
          await this.watchProject(root);
        }

        stopHeartbeat();
        writeDone(conn, {
          ok: true,
          processed: result.processed,
          indexed: result.indexed,
          total: result.total,
          failedFiles: result.failedFiles,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[daemon] addProject failed for ${path.basename(root)}:`,
          msg,
        );
        stopHeartbeat();
        writeDone(conn, { ok: false, error: msg });
      } finally {
        stopHeartbeat();
        this.shutdownAbortControllers.delete(ac);
        this.vectorDb?.resumeMaintenanceLoop();
      }
    });
  }

  async indexProject(
    root: string,
    conn: net.Socket,
    opts: { reset?: boolean; dryRun?: boolean },
  ): Promise<void> {
    await this.withProjectLock(root, async () => {
      if (!this.vectorDb || !this.metaCache) {
        writeDone(conn, { ok: false, error: "daemon resources not ready" });
        return;
      }

      // Pause the project's batch processor during full index
      const processor = this.processors.get(root);
      if (processor) {
        await processor.close();
        this.processors.delete(root);
      }
      const sub = this.subscriptions.get(root);
      if (sub) {
        await sub.unsubscribe();
        this.subscriptions.delete(root);
      }

      const ac = new AbortController();
      conn.on("close", () => ac.abort());
      this.shutdownAbortControllers.add(ac);

      this.vectorDb.pauseMaintenanceLoop();
      const stopHeartbeat = startHeartbeat(conn);
      let lastProgressTime = 0;
      // Mark this root as full-indexing so concurrent searches get a
      // partial-result footer (Phase 6); seeded at 0/0 until the first tick.
      this.indexProgress.set(root, { processed: 0, total: 0 });
      try {
        const result = await initialSync({
          projectRoot: root,
          reset: opts.reset,
          dryRun: opts.dryRun,
          vectorDb: this.vectorDb,
          metaCache: this.metaCache,
          signal: ac.signal,
          onProgress: (info) => {
            this.resetActivity();
            this.indexProgress.set(root, {
              processed: info.processed,
              total: info.total,
            });
            const now = Date.now();
            if (now - lastProgressTime < 100) return;
            lastProgressTime = now;
            writeProgress(conn, {
              processed: info.processed,
              indexed: info.indexed,
              total: info.total,
              filePath: info.filePath,
            });
          },
        });

        stopHeartbeat();
        writeDone(conn, {
          ok: true,
          processed: result.processed,
          indexed: result.indexed,
          total: result.total,
          failedFiles: result.failedFiles,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[daemon] indexProject failed for ${path.basename(root)}:`,
          msg,
        );
        stopHeartbeat();
        writeDone(conn, { ok: false, error: msg });
      } finally {
        stopHeartbeat();
        this.indexProgress.delete(root);
        this.shutdownAbortControllers.delete(ac);
        this.vectorDb?.resumeMaintenanceLoop();
        // Re-enable watcher (skip if shutting down)
        if (!this.shuttingDown) {
          try {
            await this.watchProject(root);
          } catch (err) {
            console.error(
              `[daemon] Failed to re-watch ${path.basename(root)}:`,
              err,
            );
          }
        }
      }
    });
  }

  async removeProject(root: string, conn: net.Socket): Promise<void> {
    await this.withProjectLock(root, async () => {
      if (!this.vectorDb || !this.metaCache) {
        writeDone(conn, { ok: false, error: "daemon resources not ready" });
        return;
      }

      const stopHeartbeat = startHeartbeat(conn);
      try {
        await this.unwatchProject(root);

        const rootPrefix = root.endsWith("/") ? root : `${root}/`;
        await this.vectorDb.deletePathsWithPrefix(rootPrefix);

        const keys = await this.metaCache.getKeysWithPrefix(rootPrefix);
        for (const key of keys) {
          this.metaCache.delete(key);
        }

        stopHeartbeat();
        writeDone(conn, { ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[daemon] removeProject failed for ${path.basename(root)}:`,
          msg,
        );
        stopHeartbeat();
        writeDone(conn, { ok: false, error: msg });
      } finally {
        stopHeartbeat();
      }
    });
  }

  async summarizeProject(
    root: string,
    conn: net.Socket,
    opts: { limit?: number; pathPrefix?: string },
  ): Promise<void> {
    await this.withProjectLock(root, async () => {
      if (!this.vectorDb) {
        writeDone(conn, { ok: false, error: "daemon resources not ready" });
        return;
      }

      const rootPrefix =
        opts.pathPrefix ?? (root.endsWith("/") ? root : `${root}/`);

      const stopHeartbeat = startHeartbeat(conn);
      let lastProgressTime = 0;
      try {
        const result = await generateSummaries(
          this.vectorDb,
          rootPrefix,
          (done, total) => {
            this.resetActivity();
            const now = Date.now();
            if (now - lastProgressTime < 100) return;
            lastProgressTime = now;
            writeProgress(conn, { summarized: done, total });
          },
          opts.limit,
        );

        stopHeartbeat();
        writeDone(conn, {
          ok: true,
          summarized: result.summarized,
          remaining: result.remaining,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[daemon] summarizeProject failed for ${path.basename(root)}:`,
          msg,
        );
        stopHeartbeat();
        writeDone(conn, { ok: false, error: msg });
      } finally {
        stopHeartbeat();
      }
    });
  }

  // --- LLM server management ---

  async llmStart(): Promise<{ ok: boolean; [key: string]: unknown }> {
    if (!this.llmServer) return { ok: false, error: "daemon not initialized" };
    try {
      await this.llmServer.start();
      this.resetActivity();
      return { ok: true, ...this.llmServer.getStatus() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async llmStop(): Promise<{ ok: boolean; [key: string]: unknown }> {
    if (!this.llmServer) return { ok: false, error: "daemon not initialized" };
    try {
      await this.llmServer.stop();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  llmStatus(): { ok: boolean; [key: string]: unknown } {
    if (!this.llmServer) return { ok: false, error: "daemon not initialized" };
    return { ok: true, ...this.llmServer.getStatus() };
  }

  llmTouch(): void {
    this.llmServer?.touchIdle();
  }

  async reviewCommit(root: string, commitRef: string): Promise<void> {
    this.resetActivity();
    try {
      if (!this.llmServer) {
        console.log("[review] daemon not initialized, skipping");
        return;
      }
      await this.llmServer.ensure();
      const { reviewCommit } = await import("../llm/review");
      const result = await reviewCommit({ commitRef, projectRoot: root });
      console.log(
        `[review] ${result.commit} — ${result.findingCount} finding(s) in ${result.duration}s`,
      );
    } catch (err) {
      console.error(
        `[review] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Gracefully hand off to a fresh daemon when this one has grown too old or
   * too large. Only fires when quiet — no active compaction and no in-flight
   * project operations — so a recycle never interrupts indexing work. The
   * successor re-runs catchup on startup, so nothing is lost.
   */
  private maybeRecycle(): void {
    if (this.shuttingDown || this.recycling) return;
    const ageMs = process.uptime() * 1000;
    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    const ageExceeded = MAX_LIFETIME_MS > 0 && ageMs > MAX_LIFETIME_MS;
    const rssExceeded = RSS_WATERMARK_MB > 0 && rssMb > RSS_WATERMARK_MB;
    if (!ageExceeded && !rssExceeded) return;

    // Defer while busy; we'll re-check next tick.
    if (this.vectorDb?.isMaintenanceActive()) return;
    if (this.projectLocks.size > 0) return;

    const reason = ageExceeded
      ? `age ${(ageMs / 3_600_000).toFixed(1)}h > ${(MAX_LIFETIME_MS / 3_600_000).toFixed(1)}h`
      : `rss ${Math.round(rssMb)}MB > ${RSS_WATERMARK_MB}MB`;
    console.log(
      `[daemon] Recycling (${reason}) — handing off to a fresh daemon`,
    );
    this.recycling = true;
    void this.shutdown({ relaunch: true }).finally(() => process.exit(0));
  }

  async shutdown(opts: { relaunch?: boolean } = {}): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    console.log("[daemon] Shutting down...");

    // Drop external liveness markers FIRST so the next daemon start isn't
    // fooled by leftover state if the long cleanup below is interrupted
    // (uncaught exception, second SIGTERM, OOM kill mid-shutdown). The
    // fresh-lock check in isDaemonHeartbeatFresh keyed on these — orphans
    // here used to cause silent no-op spawns for up to 150s.
    try {
      fs.unlinkSync(PATHS.daemonSocket);
    } catch {}
    try {
      fs.unlinkSync(PATHS.daemonPidFile);
    } catch {}
    if (this.releaseLock) {
      const release = this.releaseLock;
      this.releaseLock = null;
      release().catch(() => {});
    }

    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.idleInterval) clearInterval(this.idleInterval);

    // Abort in-flight index/add operations so they exit promptly
    for (const ac of this.shutdownAbortControllers) {
      ac.abort();
    }

    // Wait for in-flight project operations to finish (they check shuttingDown/signal)
    const pendingLocks = [...this.projectLocks.values()];
    if (pendingLocks.length > 0) {
      console.log(
        `[daemon] Waiting for ${pendingLocks.length} in-flight operation(s)...`,
      );
      await Promise.allSettled(pendingLocks);
    }

    // Close all processors
    for (const processor of this.processors.values()) {
      await processor.close();
    }

    // Stop LLM server if running
    try {
      await this.llmServer?.stop();
    } catch {}

    // Stop MLX embed server if we started it
    this.mlxServerManager.stopMlxServer();

    // Destroy worker pool to prevent orphaned child processes
    if (isWorkerPoolInitialized()) {
      try {
        await destroyWorkerPool();
      } catch {}
    }

    // Stop watcher poll intervals + FSEvents recovery probes, unsubscribe all
    await this.watcherManager.teardown();

    // Close server (socket/pid/lock already dropped at the top of shutdown)
    this.server?.close();

    // Unregister all
    for (const root of this.processors.keys()) {
      unregisterWatcherByRoot(root);
    }
    unregisterDaemon();
    this.processors.clear();

    // Close shared resources
    try {
      await this.metaCache?.close();
    } catch {}
    try {
      await this.vectorDb?.close();
    } catch {}

    // Hand off to a successor only after every resource is released and the
    // liveness markers (socket/pid/lock) are already gone — so the fresh
    // daemon's singleton check sees a clean slate and opens LanceDB/LMDB
    // without contending with this exiting process.
    if (opts.relaunch) {
      const pid = spawnDaemon();
      console.log(
        `[daemon] Spawned successor daemon${pid ? ` (PID: ${pid})` : " (spawn failed)"}`,
      );
    }

    console.log("[daemon] Shutdown complete");
  }
}
