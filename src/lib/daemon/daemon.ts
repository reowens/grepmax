import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { AsyncSubscription } from "@parcel/watcher";
import lockfile from "proper-lockfile";
import { CONFIG, PATHS } from "../../config";
import type { ProjectBatchProcessor } from "../index/batch-processor";
import {
  compareEmbeddingGeneration,
  type EmbeddingGenerationConfig,
  resolveEmbeddingGeneration,
} from "../index/embedding-generation";
import { projectEmbeddingStatus } from "../index/embedding-status";
import { type GlobalConfig, readGlobalConfig } from "../index/index-config";
import type { InitialSyncResult } from "../index/sync-helpers";
import { generateSummaries, initialSync } from "../index/syncer";
import { LlmServer } from "../llm/server";
import type { IndexState } from "../output/index-state-footer";
import type { Searcher } from "../search/searcher";
import { MetaCache } from "../store/meta-cache";
import { type StoreLease, StoreLeaseTimeoutError } from "../store/store-lease";
import { VectorDB } from "../store/vector-db";
import {
  clearDrainingMarker,
  writeDrainingMarker,
} from "../utils/daemon-client";
import { spawnDaemon } from "../utils/daemon-launcher";
import { KeyedMutex } from "../utils/keyed-mutex";
import { rotateLogFds } from "../utils/log-rotate";
import { debug as dbg, log as dlog } from "../utils/logger";
import {
  OperationClosedError,
  OperationCoordinator,
} from "../utils/operation-coordinator";
import { killProcess } from "../utils/process";
import {
  completeProjectRebuild,
  getProject,
  hasUnfinishedProjectRebuild,
  listProjects,
  markProjectRebuildDropping,
  ProjectRegistryConflictError,
  registerProject,
  reserveProjectsForRebuild,
  restoreProjectsAfterRebuild,
  stampProjectFullSync,
} from "../utils/project-registry";
import {
  heartbeat,
  listWatchers,
  registerDaemon,
  unregisterDaemon,
  unregisterWatcher,
  unregisterWatcherByRoot,
} from "../utils/watcher-store";
import {
  destroyWorkerPool,
  isWorkerPoolInitialized,
  WorkerPool,
} from "../workers/pool";
import {
  handleCommand,
  startHeartbeat,
  writeDone,
  writeProgress,
} from "./ipc-handler";
import { MlxServerManager } from "./mlx-server-manager";
import { ProcessManager } from "./process-manager";
import {
  type DaemonSearchPayload,
  type DaemonSearchResult,
  handleDaemonSearch,
} from "./search-handler";
import { WatcherManager } from "./watcher-manager";

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

interface DaemonResourceGeneration {
  readonly id: number;
  readonly config: GlobalConfig;
  readonly embedding: Readonly<EmbeddingGenerationConfig>;
  readonly vectorDb: VectorDB;
  readonly workerPool: WorkerPool;
  readonly mlx: "owned" | "adopted" | "cpu";
}

export class Daemon {
  private readonly processors = new Map<string, ProjectBatchProcessor>();
  private readonly searchers = new Map<string, Searcher>();
  private readonly subscriptions = new Map<string, AsyncSubscription>();
  private vectorDb: VectorDB | null = null;
  private activeConfig: GlobalConfig | null = null;
  private activeGeneration: Readonly<EmbeddingGenerationConfig> | null = null;
  private workerPool: WorkerPool | null = null;
  private resources: Readonly<DaemonResourceGeneration> | null = null;
  private nextResourceGenerationId = 1;
  private metaCache: MetaCache | null = null;
  private server: net.Server | null = null;
  private readonly connections = new Set<net.Socket>();
  private releaseLock: (() => Promise<void>) | null = null;
  private lastActivity = Date.now();
  private readonly startTime = Date.now();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private idleInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTick = 0;
  private shuttingDown = false;
  private recycling = false;
  // False until LanceDB + MetaCache are open. The socket starts listening early
  // (so liveness probes succeed during slow init), so commands that need those
  // resources must be gated on this to avoid hitting null stores mid-startup.
  private ready = false;
  private readonly processManager = new ProcessManager({
    getShuttingDown: () => this.shuttingDown,
    getWorkerPids: () => this.workerPool?.getWorkerPids(),
  });
  private readonly mlxServerManager = new MlxServerManager({
    getShuttingDown: () => this.shuttingDown,
  });
  private readonly watcherManager = new WatcherManager({
    processors: this.processors,
    subscriptions: this.subscriptions,
    getVectorDb: () => this.vectorDb,
    getMetaCache: () => this.metaCache,
    getWorkerPool: () => this.workerPool,
    getShuttingDown: () => this.shuttingDown,
    touchActivity: () => {
      this.lastActivity = Date.now();
    },
    evictSearcher: (root) => {
      this.searchers.delete(root);
    },
    runProjectOperation: (root, name, signal, fn) =>
      this.withProjectLock(root, signal, () =>
        this.runSharedOperation(name, signal, fn),
      ),
  });
  private readonly projectMutex = new KeyedMutex();
  private readonly operations = new OperationCoordinator();
  private shutdownPromise: Promise<void> | null = null;
  // Full-index progress per root while initialSync runs (--reset / initial
  // index). Presence = a full index is in flight; value drives the partial-
  // result pending count (Phase 6). Cleared in the indexProject finally.
  private readonly indexProgress = new Map<
    string,
    { processed: number; total: number }
  >();
  private readonly shutdownAbortControllers = new Set<AbortController>();
  private readonly pendingIndexRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly pendingIndexRetryCounts = new Map<string, number>();
  private llmServer: LlmServer | null = null;

  private assertStartupActive(): void {
    if (this.shuttingDown) throw new OperationClosedError();
  }

  private createWorkerPool(
    generation: Readonly<EmbeddingGenerationConfig>,
    embedMode: "cpu" | "gpu",
  ): WorkerPool {
    return new WorkerPool(generation, embedMode);
  }

  private createVectorDb(vectorDim: number, lease?: StoreLease): VectorDB {
    return new VectorDB(PATHS.lancedbDir, vectorDim, lease);
  }

  private mlxMode(config: GlobalConfig): "owned" | "adopted" | "cpu" {
    if (config.embedMode !== "gpu") return "cpu";
    const state = this.mlxServerManager.getStatus().state;
    return state === "owned-ready"
      ? "owned"
      : state === "adopted-ready"
        ? "adopted"
        : "cpu";
  }

  private publishResourceGeneration(
    config: GlobalConfig,
    embedding: Readonly<EmbeddingGenerationConfig>,
    vectorDb: VectorDB,
    workerPool: WorkerPool,
    mlx: "owned" | "adopted" | "cpu",
  ): Readonly<DaemonResourceGeneration> {
    const resources = Object.freeze({
      id: this.nextResourceGenerationId++,
      config: Object.freeze({ ...config }),
      embedding,
      vectorDb,
      workerPool,
      mlx,
    });
    this.activeConfig = resources.config;
    this.activeGeneration = resources.embedding;
    this.vectorDb = resources.vectorDb;
    this.workerPool = resources.workerPool;
    this.resources = resources;
    return resources;
  }

  async start(): Promise<void> {
    process.title = "gmax-daemon";

    // 0. Singleton enforcement: find and kill ALL stale daemon/worker processes
    await this.processManager.killStaleProcesses();
    this.assertStartupActive();

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
      this.assertStartupActive();
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
      this.connections.add(conn);
      conn.once("close", () => this.connections.delete(conn));
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
    this.assertStartupActive();

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
      this.assertStartupActive();
      unregisterWatcher(w.pid);
    }

    // 5. Open shared resources
    try {
      fs.mkdirSync(PATHS.cacheDir, { recursive: true });
      fs.mkdirSync(PATHS.lancedbDir, { recursive: true });
      console.log("[daemon] Opening LanceDB:", PATHS.lancedbDir);
      this.activeConfig = readGlobalConfig();
      this.activeGeneration = resolveEmbeddingGeneration(this.activeConfig);
      this.vectorDb = new VectorDB(
        PATHS.lancedbDir,
        this.activeGeneration.vectorDim,
      );
      this.workerPool = this.createWorkerPool(
        this.activeGeneration,
        this.activeConfig.embedMode,
      );
      this.vectorDb.startMaintenanceLoop((fn) =>
        this.runSharedOperation("store-maintenance", undefined, () => fn()),
      );
      console.log("[daemon] Opening MetaCache:", PATHS.lmdbPath);
      this.metaCache = new MetaCache(PATHS.lmdbPath);
      this.assertStartupActive();
      // Resources are open — only now may resource-dependent IPC commands run.
      this.ready = true;
    } catch (err) {
      console.error("[daemon] Failed to open shared resources:", err);
      throw err;
    }

    // 6. LLM server manager (constructed, not started — starts on first request)
    this.llmServer = new LlmServer();

    // 6b. MLX embed server — start if GPU mode is active
    const globalConfig = this.activeConfig ?? readGlobalConfig();
    const isAppleSilicon =
      process.arch === "arm64" && process.platform === "darwin";
    if (isAppleSilicon && globalConfig.embedMode === "gpu") {
      await this.mlxServerManager.ensureMlxServer(globalConfig.mlxModel);
      this.assertStartupActive();
    }
    this.publishResourceGeneration(
      globalConfig,
      this.activeGeneration!,
      this.vectorDb!,
      this.workerPool!,
      this.mlxMode(globalConfig),
    );

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
        this.assertStartupActive();
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
        !p.rebuildId &&
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
      void this.runSharedOperation("search-warmup", undefined, async () => {
        const t0 = Date.now();
        try {
          if (this.vectorDb) {
            await this.vectorDb.ensureTable();
            await this.vectorDb.createFTSIndex();
          }
          const pool = this.workerPool;
          if (!pool) throw new Error("worker pool not ready");
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
      }).catch((err) => {
        if (err instanceof OperationClosedError) return;
        console.log(`[daemon] Search warmup skipped: ${err}`);
      });
    }, 5000).unref();
  }

  watchProject(root: string, signal?: AbortSignal): Promise<void> {
    return this.withProjectLock(root, signal, () =>
      this.runSharedOperation("watch", signal, () =>
        this.watchProjectWithinOperation(root),
      ),
    );
  }

  private watchProjectWithinOperation(root: string): Promise<void> {
    const project = getProject(root);
    if (
      project?.status === "indexed" &&
      this.activeGeneration &&
      compareEmbeddingGeneration(project, this.activeGeneration).state ===
        "stale"
    ) {
      throw new Error(
        "project embedding generation is stale; run gmax repair --rebuild to rebuild the whole corpus",
      );
    }
    return this.watcherManager.watchProject(root);
  }

  runSharedOperation<T>(
    name: string,
    signal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.operations.runShared(name, signal, fn);
  }

  operationStatus(): string {
    return this.operations.status;
  }

  resourceGenerationId(): number | null {
    return this.resources?.id ?? null;
  }

  hasUnfinishedRebuild(): boolean {
    try {
      return hasUnfinishedProjectRebuild();
    } catch {
      return true;
    }
  }

  private schedulePendingIndexRetry(root: string): void {
    if (this.shuttingDown || this.pendingIndexRetryTimers.has(root)) return;
    const attempts = this.pendingIndexRetryCounts.get(root) ?? 0;
    if (attempts >= 5) return;
    this.pendingIndexRetryCounts.set(root, attempts + 1);
    const timer = setTimeout(() => {
      this.pendingIndexRetryTimers.delete(root);
      if (!this.shuttingDown) void this.indexPendingProject(root);
    }, 30_000);
    timer.unref();
    this.pendingIndexRetryTimers.set(root, timer);
  }

  private clearPendingIndexRetry(root: string): void {
    const timer = this.pendingIndexRetryTimers.get(root);
    if (timer) clearTimeout(timer);
    this.pendingIndexRetryTimers.delete(root);
    this.pendingIndexRetryCounts.delete(root);
  }

  private async indexPendingProject(root: string): Promise<void> {
    const ac = new AbortController();
    this.shutdownAbortControllers.add(ac);
    try {
      await this.withProjectLock(root, ac.signal, async () =>
        this.runSharedOperation(
          "index-pending",
          ac.signal,
          async (operationSignal) => {
            // Bail if shutdown raced ahead of us between iteration and lock
            // acquisition. Starting now would race the store close below.
            if (this.shuttingDown) return;
            if (!this.vectorDb || !this.metaCache) return;
            const current = getProject(root);
            if (current?.status !== "pending" && current?.status !== "error")
              return;

            const name = path.basename(root);
            const start = Date.now();
            dlog("daemon", `indexPendingProject start: ${name} (${root})`);
            this.vectorDb.pauseMaintenanceLoop();
            try {
              if (this.processors.has(root))
                await this.unwatchProjectWithinOperation(root);
              const result = await initialSync({
                projectRoot: root,
                vectorDb: this.vectorDb,
                metaCache: this.metaCache,
                signal: operationSignal,
                generation: this.activeGeneration ?? undefined,
                embedMode: this.activeConfig?.embedMode,
                workerPool: this.workerPool ?? undefined,
                onProgress: () => {
                  this.resetActivity();
                },
              });

              const prefix = root.endsWith("/") ? root : `${root}/`;
              const chunkCount = await this.vectorDb.countRowsForPath(prefix);
              const proj = getProject(root);
              if (proj) {
                if (result.degraded) {
                  registerProject({ ...proj, status: "pending" });
                  this.schedulePendingIndexRetry(root);
                } else {
                  this.clearPendingIndexRetry(root);
                  stampProjectFullSync({
                    root,
                    name: proj.name,
                    generation: result.generation,
                    embedMode: result.embedMode,
                    chunkCount,
                    chunkerVersion: CONFIG.CHUNKER_VERSION,
                    expectedFingerprint:
                      result.registryExpectation.embeddingFingerprint,
                    expectedRebuildId: result.registryExpectation.rebuildId,
                  });
                }
              }
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
              if (proj && !(err instanceof ProjectRegistryConflictError)) {
                registerProject({ ...proj, status: "error" });
                this.schedulePendingIndexRetry(root);
              }
            } finally {
              this.vectorDb?.resumeMaintenanceLoop();
              if (!this.shuttingDown) {
                try {
                  await this.watchProjectWithinOperation(root);
                } catch (err) {
                  console.error(`[daemon] Failed to re-watch ${name}:`, err);
                }
              }
            }
          },
        ),
      );
    } finally {
      this.shutdownAbortControllers.delete(ac);
    }
  }

  unwatchProject(root: string, signal?: AbortSignal): Promise<void> {
    return this.withProjectLock(root, signal, () =>
      this.runSharedOperation("unwatch", signal, () =>
        this.unwatchProjectWithinOperation(root),
      ),
    );
  }

  private unwatchProjectWithinOperation(root: string): Promise<void> {
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
    return this.runSharedOperation("search", signal, async (operationSignal) =>
      handleDaemonSearch(
        {
          vectorDb: this.vectorDb,
          processors: this.processors,
          indexProgress: this.indexProgress,
          searchers: this.searchers,
          getIndexState: (root) => this.indexState(root),
          touchActivity: () => {
            this.lastActivity = Date.now();
          },
          generation: this.activeGeneration,
          workerPool: this.workerPool,
        },
        payload,
        operationSignal,
      ),
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

  /** True once shared resources (LanceDB + MetaCache) are open. */
  isReady(): boolean {
    return this.ready;
  }

  getDiskPressure(): string {
    return this.vectorDb?.diskPressure ?? "unknown";
  }

  getMlxStatus() {
    return this.mlxServerManager.getStatus();
  }

  /** Reset idle timer — call during long-running operations. */
  resetActivity(): void {
    this.lastActivity = Date.now();
  }

  // --- Per-project operation serialization ---

  private async withProjectLock<T>(
    root: string,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.projectMutex.run(root, signal, fn);
  }

  // --- Streaming write operations (IPC) ---

  private activeConfigurationError(): string | null {
    const activeConfig = this.activeConfig;
    const activeGeneration = this.activeGeneration;
    if (!activeConfig || !activeGeneration) return "daemon resources not ready";
    const currentConfig = readGlobalConfig();
    let currentGeneration: Readonly<EmbeddingGenerationConfig>;
    try {
      currentGeneration = resolveEmbeddingGeneration(currentConfig);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return currentGeneration.fingerprint !== activeGeneration.fingerprint ||
      currentConfig.embedMode !== activeConfig.embedMode ||
      currentConfig.mlxModel !== activeConfig.mlxModel
      ? "daemon configuration is stale; restart the gmax daemon"
      : null;
  }

  async ensureProject(root: string, conn: net.Socket): Promise<void> {
    const ac = new AbortController();
    const onClose = () => ac.abort();
    conn.once("close", onClose);
    this.shutdownAbortControllers.add(ac);
    try {
      await this.withProjectLock(root, ac.signal, () =>
        this.runSharedOperation(
          "ensure-project",
          ac.signal,
          async (operationSignal) => {
            if (operationSignal.aborted || this.shuttingDown) return;
            const activeConfig = this.activeConfig;
            const configurationError = this.activeConfigurationError();
            if (!activeConfig || configurationError) {
              writeDone(conn, {
                ok: false,
                error: configurationError ?? "daemon resources not ready",
              });
              return;
            }

            const project = getProject(root);
            if (project?.status === "indexed") {
              if (
                !this.activeGeneration ||
                compareEmbeddingGeneration(project, this.activeGeneration)
                  .state === "stale"
              ) {
                writeDone(conn, {
                  ok: false,
                  error:
                    "project embedding generation is stale; run gmax repair --rebuild to rebuild the whole corpus",
                });
                return;
              }
              await this.watchProjectWithinOperation(root);
              writeDone(conn, { ok: true, status: "indexed", watched: true });
              return;
            }

            registerProject({
              root,
              name: project?.name ?? path.basename(root),
              vectorDim: activeConfig.vectorDim,
              modelTier: activeConfig.modelTier,
              embedMode: activeConfig.embedMode,
              lastIndexed: project?.lastIndexed ?? "",
              chunkCount: project?.chunkCount,
              status: "pending",
              chunkerVersion: project?.chunkerVersion,
            });
            await this.addProjectLocked(root, conn, operationSignal, project);
          },
        ),
      );
    } finally {
      conn.off("close", onClose);
      this.shutdownAbortControllers.delete(ac);
    }
  }

  async addProject(root: string, conn: net.Socket): Promise<void> {
    const ac = new AbortController();
    const onClose = () => ac.abort();
    conn.once("close", onClose);
    this.shutdownAbortControllers.add(ac);
    try {
      await this.withProjectLock(root, ac.signal, () =>
        this.runSharedOperation(
          "add-project",
          ac.signal,
          async (operationSignal) => {
            if (operationSignal.aborted || this.shuttingDown) return;
            const configurationError = this.activeConfigurationError();
            if (configurationError) {
              writeDone(conn, { ok: false, error: configurationError });
              return;
            }
            await this.addProjectLocked(
              root,
              conn,
              operationSignal,
              getProject(root),
            );
          },
        ),
      );
    } finally {
      conn.off("close", onClose);
      this.shutdownAbortControllers.delete(ac);
    }
  }

  private async addProjectLocked(
    root: string,
    conn: net.Socket,
    signal: AbortSignal,
    previousProject: ReturnType<typeof getProject>,
  ): Promise<void> {
    if (!this.vectorDb || !this.metaCache || !this.activeConfig) {
      writeDone(conn, { ok: false, error: "daemon resources not ready" });
      return;
    }

    if (!getProject(root)) {
      registerProject({
        root,
        name: path.basename(root),
        vectorDim: this.activeConfig.vectorDim,
        modelTier: this.activeConfig.modelTier,
        embedMode: this.activeConfig.embedMode,
        lastIndexed: "",
        status: "pending",
      });
    }

    this.vectorDb.pauseMaintenanceLoop();
    const stopHeartbeat = startHeartbeat(conn);
    let lastProgressTime = 0;
    try {
      const result = await initialSync({
        projectRoot: root,
        vectorDb: this.vectorDb,
        metaCache: this.metaCache,
        signal,
        generation: this.activeGeneration ?? undefined,
        embedMode: this.activeConfig.embedMode,
        workerPool: this.workerPool ?? undefined,
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

      if (signal.aborted || this.shuttingDown) {
        const abortError = new Error("Aborted");
        abortError.name = "AbortError";
        throw abortError;
      }

      const prefix = root.endsWith("/") ? root : `${root}/`;
      const chunkCount = await this.vectorDb.countRowsForPath(prefix);
      const project = getProject(root);
      if (result.degraded) {
        if (previousProject) registerProject(previousProject);
        this.schedulePendingIndexRetry(root);
      } else {
        this.clearPendingIndexRetry(root);
        stampProjectFullSync({
          root,
          name: project?.name ?? path.basename(root),
          generation: result.generation,
          embedMode: result.embedMode,
          chunkCount,
          chunkerVersion: CONFIG.CHUNKER_VERSION,
          expectedFingerprint: result.registryExpectation.embeddingFingerprint,
          expectedRebuildId: result.registryExpectation.rebuildId,
        });
      }
      await this.watchProjectWithinOperation(root);

      writeDone(conn, {
        ok: true,
        processed: result.processed,
        indexed: result.indexed,
        total: result.total,
        failedFiles: result.failedFiles,
        degraded: result.degraded,
        scanErrors: result.scanErrors,
      });
    } catch (err) {
      const aborted = signal.aborted || (err as Error)?.name === "AbortError";
      if (aborted) {
        if (previousProject) registerProject(previousProject);
        writeDone(conn, { ok: false, error: "aborted" });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[daemon] addProject failed for ${path.basename(root)}:`,
          msg,
        );
        const project = getProject(root);
        if (project && !(err instanceof ProjectRegistryConflictError)) {
          registerProject({ ...project, status: "error" });
        }
        writeDone(conn, { ok: false, error: msg });
      }
    } finally {
      stopHeartbeat();
      this.vectorDb?.resumeMaintenanceLoop();
    }
  }

  async projectStats(root: string): Promise<{
    files: number;
    chunks: number;
    vectorDim: number;
    modelTier: string;
    embedMode: string;
    indexedAt: string;
    watching: boolean;
    configuredEmbedding: Readonly<EmbeddingGenerationConfig>;
    builtEmbedding: Readonly<EmbeddingGenerationConfig> | null;
    embeddingState: "current" | "legacy" | "stale" | "unbuilt";
  }> {
    return this.runSharedOperation("project-stats", undefined, async () => {
      if (!this.vectorDb) throw new Error("daemon resources not ready");
      const project = getProject(root);
      if (!project) throw new Error("project not registered");
      if (!this.activeConfig) throw new Error("daemon resources not ready");
      const identity = projectEmbeddingStatus(project, this.activeConfig);
      const prefix = root.endsWith("/") ? root : `${root}/`;
      const [chunks, files] = await Promise.all([
        this.vectorDb.countRowsForPath(prefix),
        this.vectorDb.countDistinctFilesForPath(prefix),
      ]);
      return {
        files,
        chunks,
        vectorDim: project.vectorDim,
        modelTier: project.modelTier,
        embedMode: project.embedMode,
        indexedAt: project.lastIndexed,
        watching: this.processors.has(root),
        configuredEmbedding: identity.configured,
        builtEmbedding: identity.built,
        embeddingState: identity.state,
      };
    });
  }

  /**
   * Core full-(re)index of one project: quiesce its batch processor + watcher,
   * run initialSync, then re-watch in the finally. Shared by indexProject (one
   * project per IPC connection) and repairRebuild (all projects after a global
   * table drop). The caller owns the project lock, the maintenance pause, the
   * heartbeat, and the AbortController; this method owns the watcher handoff and
   * the indexProgress bookkeeping (so concurrent searches get a partial-result
   * footer while it runs — Phase 6).
   */
  private async reindexOneProject(
    root: string,
    opts: { reset?: boolean; dryRun?: boolean; rewatch?: boolean },
    signal: AbortSignal,
    onProgress: (info: {
      processed: number;
      indexed: number;
      total: number;
      filePath?: string;
    }) => void,
  ): Promise<InitialSyncResult> {
    if (!this.vectorDb || !this.metaCache) {
      throw new Error("daemon resources not ready");
    }

    // Quiesce the subscription, processor, and any catchup generation before
    // full sync takes deletion authority for this project.
    await this.unwatchProjectWithinOperation(root);

    // Mark this root as full-indexing so concurrent searches get a
    // partial-result footer (Phase 6); seeded at 0/0 until the first tick.
    this.indexProgress.set(root, { processed: 0, total: 0 });
    try {
      return await initialSync({
        projectRoot: root,
        reset: opts.reset,
        dryRun: opts.dryRun,
        vectorDb: this.vectorDb,
        metaCache: this.metaCache,
        signal,
        generation: this.activeGeneration ?? undefined,
        embedMode: this.activeConfig?.embedMode,
        workerPool: this.workerPool ?? undefined,
        onProgress: (info) => {
          this.resetActivity();
          this.indexProgress.set(root, {
            processed: info.processed,
            total: info.total,
          });
          onProgress(info);
        },
      });
    } finally {
      this.indexProgress.delete(root);
      // Re-enable watcher (skip if shutting down)
      if (!this.shuttingDown && opts.rewatch !== false) {
        try {
          await this.watchProjectWithinOperation(root);
        } catch (err) {
          console.error(
            `[daemon] Failed to re-watch ${path.basename(root)}:`,
            err,
          );
        }
      }
    }
  }

  async indexProject(
    root: string,
    conn: net.Socket,
    opts: { reset?: boolean; dryRun?: boolean },
  ): Promise<void> {
    const ac = new AbortController();
    const onClose = () => ac.abort();
    conn.once("close", onClose);
    this.shutdownAbortControllers.add(ac);
    try {
      await this.withProjectLock(root, ac.signal, () =>
        this.runSharedOperation(
          "index-project",
          ac.signal,
          async (operationSignal) => {
            if (!this.vectorDb || !this.metaCache) {
              writeDone(conn, {
                ok: false,
                error: "daemon resources not ready",
              });
              return;
            }

            this.vectorDb.pauseMaintenanceLoop();
            const stopHeartbeat = startHeartbeat(conn);
            let lastProgressTime = 0;
            try {
              const result = await this.reindexOneProject(
                root,
                opts,
                operationSignal,
                (info) => {
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
              );

              if (!opts.dryRun && !result.degraded) {
                const prefix = root.endsWith("/") ? root : `${root}/`;
                const chunkCount = await this.vectorDb.countRowsForPath(prefix);
                const project = getProject(root);
                stampProjectFullSync({
                  root,
                  generation: result.generation,
                  embedMode: result.embedMode,
                  chunkCount,
                  chunkerVersion: opts.reset
                    ? CONFIG.CHUNKER_VERSION
                    : (project?.chunkerVersion ?? 1),
                  expectedFingerprint:
                    result.registryExpectation.embeddingFingerprint,
                  expectedRebuildId: result.registryExpectation.rebuildId,
                });
              }

              writeDone(conn, {
                ok: true,
                processed: result.processed,
                indexed: result.indexed,
                total: result.total,
                failedFiles: result.failedFiles,
                degraded: result.degraded,
                scanErrors: result.scanErrors,
                embeddingFingerprint: result.generation.fingerprint,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(
                `[daemon] indexProject failed for ${path.basename(root)}:`,
                msg,
              );
              writeDone(conn, { ok: false, error: msg });
            } finally {
              stopHeartbeat();
              this.vectorDb?.resumeMaintenanceLoop();
            }
          },
        ),
      );
    } finally {
      conn.off("close", onClose);
      this.shutdownAbortControllers.delete(ac);
    }
  }

  /**
   * Global recovery for a physical table-width mismatch (the chosen "global
   * rebuild" strategy): drop the shared `chunks` table and re-index every
   * registered project at the configured dim. The table is fixed-width at
   * creation, so this is the only way to move it from e.g. 384d to 768d after a
   * tier change. Streams per-project progress over `conn`. Each project is
   * reindexed under its own lock with `reset: true`, which also clears that
   * project's stale MetaCache entries so everything re-embeds into the freshly
   * recreated (lazily, at config width) table.
   */
  async repairRebuild(conn: net.Socket): Promise<void> {
    const oldResources = this.resources;
    const metaCache = this.metaCache;
    if (!oldResources || !metaCache) {
      writeDone(conn, { ok: false, error: "daemon resources not ready" });
      return;
    }

    const targetConfig = readGlobalConfig();
    const targetGeneration = resolveEmbeddingGeneration(targetConfig);
    const clientAbort = new AbortController();
    let dropCommitted = false;
    let desiredWatchRoots: string[] = [];
    let watchersRestored = false;
    let oldPoolDestroyed = false;
    let oldDbClosed = false;
    const failClosedOldResources = async (lease: StoreLease): Promise<void> => {
      this.ready = false;
      this.resources = null;
      this.vectorDb = null;
      this.workerPool = null;
      if (!oldPoolDestroyed) {
        await oldResources.workerPool
          .destroy({ requireExit: true })
          .catch(() => {});
        oldPoolDestroyed = true;
      }
      if (!oldDbClosed) {
        await oldResources.vectorDb.close().catch(() => {});
        oldDbClosed = true;
      }
      await lease.release().catch(() => {});
    };
    const onClose = () => {
      if (!dropCommitted) clientAbort.abort(new Error("client disconnected"));
    };
    conn.once("close", onClose);
    const stopHeartbeat = startHeartbeat(conn);

    const throwIfPreDropCancelled = (operationSignal: AbortSignal) => {
      if (operationSignal.aborted) throw operationSignal.reason;
      if (!dropCommitted && clientAbort.signal.aborted) {
        throw clientAbort.signal.reason;
      }
    };

    try {
      const result = await this.operations.runExclusive(
        "repair",
        async () => {
          desiredWatchRoots = await this.watcherManager.quiesceAll();
        },
        async (operationSignal) => {
          throwIfPreDropCancelled(operationSignal);
          oldResources.vectorDb.pauseMaintenanceLoop();
          this.searchers.clear();

          writeProgress(conn, {
            phase: "lease",
            message: "waiting for exclusive store ownership",
          });
          let exclusiveLease: StoreLease | null = null;
          try {
            exclusiveLease = await oldResources.vectorDb.upgradeStoreLease(
              AbortSignal.any([operationSignal, clientAbort.signal]),
            );
            throwIfPreDropCancelled(operationSignal);
          } catch (error) {
            if (exclusiveLease) {
              try {
                await oldResources.vectorDb.downgradeStoreLease();
              } catch (downgradeError) {
                await failClosedOldResources(exclusiveLease);
                throw new Error(
                  `Failed to restore shared store ownership: ${String(downgradeError)}`,
                );
              }
            }
            oldResources.vectorDb.resumeMaintenanceLoop();
            throw error;
          }
          if (!exclusiveLease) {
            throw new Error(
              "Exclusive store lease acquisition returned no lease",
            );
          }

          let reservation: ReturnType<typeof reserveProjectsForRebuild>;
          try {
            reservation = reserveProjectsForRebuild(targetGeneration);
          } catch (error) {
            try {
              await oldResources.vectorDb.downgradeStoreLease();
            } catch (downgradeError) {
              await failClosedOldResources(exclusiveLease);
              throw new Error(
                `Failed to restore shared store ownership: ${String(downgradeError)}`,
              );
            }
            oldResources.vectorDb.resumeMaintenanceLoop();
            throw error;
          }
          let targetDb: VectorDB | null = null;
          let targetPool: WorkerPool | null = null;
          let published = false;
          try {
            writeProgress(conn, {
              phase: "prepare",
              rebuildId: reservation.rebuildId,
              projects: reservation.reserved.length,
            });
            await oldResources.workerPool.destroy({ requireExit: true });
            oldPoolDestroyed = true;
            if (oldResources.mlx === "owned") {
              await this.mlxServerManager.stopMlxServer();
            }
            throwIfPreDropCancelled(operationSignal);

            await oldResources.vectorDb.close({
              releaseLease: false,
              requireClosed: true,
            });
            oldDbClosed = true;
            throwIfPreDropCancelled(operationSignal);
            targetDb = this.createVectorDb(
              targetGeneration.vectorDim,
              exclusiveLease,
            );
            markProjectRebuildDropping(reservation);

            try {
              await targetDb.drop();
              dropCommitted = true;
              conn.off("close", onClose);
            } catch (error) {
              // LanceDB does not expose a commit token. Inspect physical state:
              // an absent table means the destructive commit happened; an
              // unreadable state is treated as uncertain and therefore post-drop.
              try {
                dropCommitted = (await targetDb.getSchemaVectorDim()) === null;
              } catch {
                dropCommitted = true;
              }
              if (dropCommitted) conn.off("close", onClose);
              throw error;
            }

            writeProgress(conn, {
              phase: "schema",
              message: "creating target table",
            });
            await targetDb.ensureTable();
            const physicalDim = await targetDb.getSchemaVectorDim();
            if (physicalDim !== targetGeneration.vectorDim) {
              throw new Error(
                `rebuilt table dimension ${physicalDim ?? "missing"} does not match target ${targetGeneration.vectorDim}`,
              );
            }

            if (targetConfig.embedMode === "gpu") {
              await this.mlxServerManager.ensureMlxServer(
                targetGeneration.mlxModel,
              );
            }
            const targetMlx = this.mlxMode(targetConfig);
            targetPool = this.createWorkerPool(
              targetGeneration,
              targetConfig.embedMode,
            );
            this.publishResourceGeneration(
              targetConfig,
              targetGeneration,
              targetDb,
              targetPool,
              targetMlx,
            );
            published = true;

            let completed = 0;
            const failures: Array<{ root: string; error: string }> = [];
            for (const project of reservation.reserved) {
              if (operationSignal.aborted) throw operationSignal.reason;
              writeProgress(conn, {
                phase: "index",
                root: project.root,
                project: project.name,
                completed,
                totalProjects: reservation.reserved.length,
              });
              try {
                const sync = await this.reindexOneProject(
                  project.root,
                  { reset: true, rewatch: false },
                  operationSignal,
                  (info) =>
                    writeProgress(conn, {
                      phase: "index",
                      root: project.root,
                      project: project.name,
                      processed: info.processed,
                      indexed: info.indexed,
                      total: info.total,
                      filePath: info.filePath,
                    }),
                );
                if (sync.degraded) {
                  throw new Error(
                    `degraded scan (${sync.failedFiles} failed files)`,
                  );
                }
                const prefix = project.root.endsWith("/")
                  ? project.root
                  : `${project.root}/`;
                const chunkCount = await targetDb.countRowsForPath(prefix);
                stampProjectFullSync({
                  root: project.root,
                  name: project.name,
                  generation: sync.generation,
                  embedMode: sync.embedMode,
                  chunkCount,
                  chunkerVersion: CONFIG.CHUNKER_VERSION,
                  expectedFingerprint: targetGeneration.fingerprint,
                  expectedRebuildId: reservation.rebuildId,
                });
                completed++;
              } catch (error) {
                failures.push({
                  root: project.root,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }

            await targetDb.downgradeStoreLease();
            targetDb.startMaintenanceLoop((fn) =>
              this.runSharedOperation("store-maintenance", undefined, () =>
                fn(),
              ),
            );

            const currentGeneration = resolveEmbeddingGeneration(
              readGlobalConfig(),
            );
            const configChanged =
              currentGeneration.fingerprint !== targetGeneration.fingerprint;
            if (failures.length === 0) {
              completeProjectRebuild(reservation.rebuildId);
            }
            return {
              completed,
              total: reservation.reserved.length,
              failures,
              configChanged,
              generation: targetGeneration.fingerprint,
            };
          } catch (error) {
            if (!dropCommitted) {
              this.ready = false;
              this.resources = null;
              let recoveryError: unknown;
              await targetPool
                ?.destroy({ requireExit: true })
                .catch((cause) => {
                  recoveryError ??= cause;
                });
              if (targetDb) {
                await targetDb
                  .close({ releaseLease: false, requireClosed: true })
                  .catch((cause) => {
                    recoveryError ??= cause;
                  });
              }
              try {
                restoreProjectsAfterRebuild(reservation);
              } catch (cause) {
                recoveryError ??= cause;
              }

              if (!recoveryError && !oldPoolDestroyed) {
                try {
                  await oldResources.vectorDb.downgradeStoreLease();
                  oldResources.vectorDb.resumeMaintenanceLoop();
                  this.resources = oldResources;
                  this.activeConfig = oldResources.config;
                  this.activeGeneration = oldResources.embedding;
                  this.vectorDb = oldResources.vectorDb;
                  this.workerPool = oldResources.workerPool;
                  this.ready = true;
                } catch (cause) {
                  recoveryError = cause;
                }
              } else if (!recoveryError) {
                let restoredDb: VectorDB | null = null;
                let restoredPool: WorkerPool | null = null;
                try {
                  restoredDb = oldDbClosed
                    ? this.createVectorDb(
                        oldResources.embedding.vectorDim,
                        exclusiveLease,
                      )
                    : oldResources.vectorDb;
                  if (
                    oldResources.config.embedMode === "gpu" &&
                    oldResources.mlx === "owned"
                  ) {
                    await this.mlxServerManager.ensureMlxServer(
                      oldResources.embedding.mlxModel,
                    );
                  }
                  restoredPool = this.createWorkerPool(
                    oldResources.embedding,
                    oldResources.config.embedMode,
                  );
                  await restoredDb.downgradeStoreLease();
                  restoredDb.startMaintenanceLoop((fn) =>
                    this.runSharedOperation(
                      "store-maintenance",
                      undefined,
                      () => fn(),
                    ),
                  );
                  this.publishResourceGeneration(
                    oldResources.config,
                    oldResources.embedding,
                    restoredDb,
                    restoredPool,
                    this.mlxMode(oldResources.config),
                  );
                  this.ready = true;
                } catch (cause) {
                  recoveryError = cause;
                  await restoredPool
                    ?.destroy({ requireExit: true })
                    .catch(() => {});
                  if (restoredDb) {
                    await restoredDb.close().catch(() => {});
                  } else {
                    await exclusiveLease.release().catch(() => {});
                  }
                }
              }

              if (recoveryError) {
                if (!oldPoolDestroyed) {
                  await oldResources.workerPool
                    .destroy({ requireExit: true })
                    .catch((cause) => {
                      recoveryError = new Error(
                        `Pre-drop rebuild pool cleanup failed: ${String(recoveryError)}; ${String(cause)}`,
                      );
                    });
                  oldPoolDestroyed = true;
                }
                if (!oldDbClosed) {
                  await oldResources.vectorDb.close().catch((cause) => {
                    recoveryError = new Error(
                      `Pre-drop rebuild DB cleanup failed: ${String(recoveryError)}; ${String(cause)}`,
                    );
                  });
                  oldDbClosed = true;
                }
                await exclusiveLease.release().catch((cause) => {
                  recoveryError = new Error(
                    `Pre-drop rebuild cleanup failed: ${String(recoveryError)}; ${String(cause)}`,
                  );
                });
                this.resources = null;
                this.vectorDb = null;
                this.workerPool = null;
                this.ready = false;
                throw new Error(
                  `Pre-drop rebuild recovery failed: ${String(error)}; ${String(recoveryError)}`,
                );
              }
            } else {
              this.ready = false;
              this.resources = null;
              this.activeConfig = targetConfig;
              this.activeGeneration = targetGeneration;
              this.vectorDb = targetDb;
              this.workerPool = published ? targetPool : null;
              if (targetDb) {
                await targetDb.downgradeStoreLease().catch(() => {});
              } else {
                await exclusiveLease.release().catch(() => {});
              }
            }
            throw error;
          }
        },
      );

      for (const root of desiredWatchRoots) {
        if (getProject(root)?.status !== "indexed") continue;
        try {
          await this.watcherManager.watchProject(root, { catchup: false });
        } catch (error) {
          result.failures.push({
            root,
            error: `watch restore failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      watchersRestored = true;
      try {
        await this.watcherManager.catchupAll(desiredWatchRoots);
      } catch (error) {
        result.failures.push({
          root: "*",
          error: `watch catchup failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      writeDone(conn, {
        ok: result.failures.length === 0,
        ...result,
        ...(result.configChanged
          ? {
              warning:
                "configured embedding changed during rebuild; another rebuild is required",
            }
          : {}),
      });
    } catch (error) {
      let reportedError: unknown = error;
      if (!dropCommitted && !watchersRestored && this.ready && this.resources) {
        try {
          await this.watcherManager.resumeAll(desiredWatchRoots, {
            catchup: false,
          });
          watchersRestored = true;
          await this.watcherManager.catchupAll(desiredWatchRoots);
        } catch (watchError) {
          this.ready = false;
          this.resources = null;
          reportedError = new Error(
            `Pre-drop rebuild watcher restoration failed: ${String(error)}; ${String(watchError)}`,
          );
        }
      }
      const details =
        reportedError instanceof StoreLeaseTimeoutError
          ? { blockers: reportedError.blockers }
          : {};
      writeDone(conn, {
        ok: false,
        error:
          reportedError instanceof Error
            ? reportedError.message
            : String(reportedError),
        degraded: dropCommitted,
        ...details,
      });
    } finally {
      conn.off("close", onClose);
      stopHeartbeat();
      if (!this.ready) {
        setImmediate(() => void this.shutdown());
      }
    }
  }

  async removeProject(root: string, conn: net.Socket): Promise<void> {
    const ac = new AbortController();
    const onClose = () => ac.abort();
    conn.once("close", onClose);
    this.shutdownAbortControllers.add(ac);
    try {
      await this.withProjectLock(root, ac.signal, () =>
        this.runSharedOperation("remove-project", ac.signal, async () => {
          if (!this.vectorDb || !this.metaCache) {
            writeDone(conn, {
              ok: false,
              error: "daemon resources not ready",
            });
            return;
          }

          const stopHeartbeat = startHeartbeat(conn);
          const wasWatching = this.processors.has(root);
          let unwatched = false;
          try {
            await this.unwatchProjectWithinOperation(root);
            unwatched = true;

            const rootPrefix = root.endsWith("/") ? root : `${root}/`;
            await this.vectorDb.deletePathsWithPrefix(rootPrefix);

            const keys = await this.metaCache.getKeysWithPrefix(rootPrefix);
            for (const key of keys) this.metaCache.delete(key);

            writeDone(conn, { ok: true });
          } catch (err) {
            let reportedError = err;
            if (unwatched && wasWatching && !this.shuttingDown) {
              try {
                await this.watchProjectWithinOperation(root);
              } catch (watchError) {
                reportedError = new Error(
                  `Project removal failed: ${String(err)}; watcher restoration failed: ${String(watchError)}`,
                );
              }
            }
            const msg =
              reportedError instanceof Error
                ? reportedError.message
                : String(reportedError);
            console.error(
              `[daemon] removeProject failed for ${path.basename(root)}:`,
              msg,
            );
            writeDone(conn, { ok: false, error: msg });
          } finally {
            stopHeartbeat();
          }
        }),
      );
    } finally {
      conn.off("close", onClose);
      this.shutdownAbortControllers.delete(ac);
    }
  }

  async summarizeProject(
    root: string,
    conn: net.Socket,
    opts: { limit?: number; pathPrefix?: string },
  ): Promise<void> {
    const ac = new AbortController();
    const onClose = () => ac.abort();
    conn.once("close", onClose);
    this.shutdownAbortControllers.add(ac);
    try {
      await this.withProjectLock(root, ac.signal, () =>
        this.runSharedOperation("summarize-project", ac.signal, async () => {
          if (!this.vectorDb) {
            writeDone(conn, {
              ok: false,
              error: "daemon resources not ready",
            });
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
            writeDone(conn, { ok: false, error: msg });
          } finally {
            stopHeartbeat();
          }
        }),
      );
    } finally {
      conn.off("close", onClose);
      this.shutdownAbortControllers.delete(ac);
    }
  }

  // --- LLM server management ---

  async llmStart(): Promise<{ ok: boolean; [key: string]: unknown }> {
    return this.runSharedOperation("llm-start", undefined, async () => {
      if (!this.llmServer)
        return { ok: false, error: "daemon not initialized" };
      try {
        await this.llmServer.start();
        this.resetActivity();
        return { ok: true, ...this.llmServer.getStatus() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    });
  }

  async llmStop(): Promise<{ ok: boolean; [key: string]: unknown }> {
    return this.runSharedOperation("llm-stop", undefined, async () => {
      if (!this.llmServer)
        return { ok: false, error: "daemon not initialized" };
      try {
        await this.llmServer.stop();
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    });
  }

  llmStatus(): { ok: boolean; [key: string]: unknown } {
    if (!this.llmServer) return { ok: false, error: "daemon not initialized" };
    return { ok: true, ...this.llmServer.getStatus() };
  }

  llmTouch(): void {
    this.llmServer?.touchIdle();
  }

  async reviewCommit(root: string, commitRef: string): Promise<void> {
    return this.runSharedOperation("review", undefined, async () => {
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
    });
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
    if (this.projectMutex.pending > 0 || this.operations.activeCount > 0)
      return;

    const reason = ageExceeded
      ? `age ${(ageMs / 3_600_000).toFixed(1)}h > ${(MAX_LIFETIME_MS / 3_600_000).toFixed(1)}h`
      : `rss ${Math.round(rssMb)}MB > ${RSS_WATERMARK_MB}MB`;
    console.log(
      `[daemon] Recycling (${reason}) — handing off to a fresh daemon`,
    );
    this.recycling = true;
    void this.shutdown({ relaunch: true }).finally(() => process.exit(0));
  }

  shutdown(opts: { relaunch?: boolean } = {}): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.performShutdown(opts);
    }
    return this.shutdownPromise;
  }

  private async performShutdown(opts: { relaunch?: boolean }): Promise<void> {
    this.shuttingDown = true;
    this.ready = false;
    const strictResourceShutdown = this.hasUnfinishedRebuild();

    console.log("[daemon] Shutting down...");

    // Announce graceful shutdown BEFORE dropping the liveness markers below, so a
    // successor spawned during the (possibly long) drain sees the draining marker
    // and defers instead of SIGKILLing us mid-cleanup.
    writeDrainingMarker(process.pid);

    // Stop accepting new IPC before draining admitted operations. Existing
    // sockets are destroyed below so their close handlers cancel queued work.
    const server = this.server;
    this.server = null;
    const serverClosed = new Promise<void>((resolve) => {
      if (!server?.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    for (const connection of this.connections) connection.end();
    const forceCloseConnections = setTimeout(() => {
      for (const connection of this.connections) connection.destroy();
    }, 1000);
    forceCloseConnections.unref();

    // Drop external liveness markers now so interrupted cleanup cannot leave a
    // fresh-looking daemon that silently blocks its successor.
    try {
      fs.unlinkSync(PATHS.daemonSocket);
    } catch {}
    try {
      fs.unlinkSync(PATHS.daemonPidFile);
    } catch {}
    if (this.releaseLock) {
      const release = this.releaseLock;
      this.releaseLock = null;
      try {
        await release();
      } catch {}
    }

    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.idleInterval) clearInterval(this.idleInterval);
    for (const timer of this.pendingIndexRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingIndexRetryTimers.clear();
    this.pendingIndexRetryCounts.clear();

    // Abort explicit operation controllers, close coordinator admission, and
    // reject queued project waiters. Start these drains before watcher teardown
    // so no timer or socket can admit replacement work.
    for (const ac of this.shutdownAbortControllers) {
      ac.abort(new OperationClosedError());
    }
    const operationDrain = this.operations.close();
    const projectDrain = this.projectMutex.close();

    // Abort catchup/recovery and remove each processor before worker teardown.
    await this.watcherManager.quiesceAll();
    await Promise.all([operationDrain, projectDrain]);

    // Stop LLM server if running
    try {
      await this.llmServer?.stop();
    } catch {}

    // Destroy worker pool to prevent orphaned child processes
    if (this.workerPool) {
      if (strictResourceShutdown) {
        await this.workerPool.destroy({
          requireExit: true,
        });
      } else {
        try {
          await this.workerPool.destroy();
        } catch {}
      }
      this.workerPool = null;
      this.resources = null;
    }
    if (isWorkerPoolInitialized()) {
      try {
        await destroyWorkerPool();
      } catch {}
    }

    // Stop MLX embed server only after worker requests have drained.
    await this.mlxServerManager.stopMlxServer();

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
    if (strictResourceShutdown) {
      await this.vectorDb?.close({ requireClosed: true });
    } else {
      try {
        await this.vectorDb?.close();
      } catch {}
    }
    await serverClosed;
    clearTimeout(forceCloseConnections);
    this.connections.clear();

    // Hand off to a successor only after every resource is released and the
    // liveness markers (socket/pid/lock) are already gone — so the fresh
    // daemon's singleton check sees a clean slate and opens LanceDB/LMDB
    // without contending with this exiting process.
    if (opts.relaunch) {
      const pid = await spawnDaemon();
      console.log(
        `[daemon] Spawned successor daemon${pid ? ` (PID: ${pid})` : " (spawn failed)"}`,
      );
    }

    // Cleanly drained — drop the marker so a later start doesn't defer to a
    // process that's already gone (it self-expires after DRAIN_GRACE_MS anyway).
    clearDrainingMarker();

    console.log("[daemon] Shutdown complete");
  }
}
