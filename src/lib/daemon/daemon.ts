import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as watcher from "@parcel/watcher";
import type { AsyncSubscription } from "@parcel/watcher";
import lockfile from "proper-lockfile";
import { PATHS } from "../../config";
import { ProjectBatchProcessor } from "../index/batch-processor";
import { initialSync, generateSummaries } from "../index/syncer";
import { WATCHER_IGNORE_GLOBS } from "../index/watcher";
import { Searcher } from "../search/searcher";
import { getStoredSkeleton } from "../skeleton/retriever";
import type { ChunkType, SearchFilter } from "../store/types";
import type { IndexState } from "../output/index-state-footer";
import { MetaCache } from "../store/meta-cache";
import { VectorDB } from "../store/vector-db";
import { killProcess } from "../utils/process";
import { getProject, listProjects, registerProject } from "../utils/project-registry";
import {
  heartbeat,
  listWatchers,
  registerDaemon,
  registerWatcher,
  unregisterDaemon,
  unregisterWatcher,
  unregisterWatcherByRoot,
} from "../utils/watcher-store";
import { LlmServer } from "../llm/server";
import { handleCommand, writeProgress, writeDone, startHeartbeat } from "./ipc-handler";
import { log as dlog, debug as dbg } from "../utils/logger";
import { isDaemonRunning, isDaemonHeartbeatFresh } from "../utils/daemon-client";
import { readGlobalConfig } from "../index/index-config";
import { openRotatedLog, rotateLogFds } from "../utils/log-rotate";
import {
  destroyWorkerPool,
  isWorkerPoolInitialized,
  getWorkerPool,
} from "../workers/pool";
import { spawnDaemon } from "../utils/daemon-launcher";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as http from "node:http";

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
const MAX_LIFETIME_MS = envNum("GMAX_DAEMON_MAX_LIFETIME_MS", 24 * 60 * 60 * 1000);
const RSS_WATERMARK_MB = envNum("GMAX_DAEMON_RSS_WATERMARK_MB", 2560);

// Watcher health windows used for FSEvents auto-recovery.
const FSEVENTS_RECOVERY_INTERVAL_MS = 60 * 60 * 1000; // try recovery hourly
const FSEVENTS_HEALTH_WINDOW_MS = 5 * 60 * 1000; // 5 min of quiet = "healthy"

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
  private mlxRecoveryInFlight = false;
  private shuttingDown = false;
  private recycling = false;
  // PIDs flagged as orphan workers on the previous sweep. A worker must look
  // orphaned twice in a row before we kill it, so a worker the pool forked
  // between our process snapshot and its array update is never killed by a race.
  private suspectedOrphanWorkers = new Set<number>();
  private readonly pendingOps = new Set<string>();
  private readonly watcherFailCount = new Map<string, number>();
  private readonly pollIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pollRecoveryTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lastOverflowMs = new Map<string, number>();
  private readonly lastCatchupEndMs = new Map<string, number>();
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
  private mlxChild: ChildProcess | null = null;

  async start(): Promise<void> {
    process.title = "gmax-daemon";

    // 0. Singleton enforcement: find and kill ALL stale daemon/worker processes
    await this.killStaleProcesses();

    // 1. Acquire exclusive lock — kernel-enforced, atomic, auto-released on death
    fs.mkdirSync(path.dirname(PATHS.daemonLockFile), { recursive: true });
    fs.writeFileSync(PATHS.daemonLockFile, "", { flag: "a" }); // ensure file exists
    dbg("daemon", "acquiring lock...");
    try {
      this.releaseLock = await lockfile.lock(PATHS.daemonLockFile, {
        retries: 0,
        stale: 120_000,
        onCompromised: () => {
          console.error("[daemon] Lock compromised — another daemon took over. Shutting down.");
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
    try { fs.unlinkSync(PATHS.daemonSocket); } catch {}

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
          conn.write(`${JSON.stringify({ ok: false, error: "invalid JSON" })}\n`);
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
      console.log(`[daemon] Taking over from per-project watcher (PID: ${w.pid}, ${path.basename(w.projectRoot)})`);
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
    const isAppleSilicon = process.arch === "arm64" && process.platform === "darwin";
    if (isAppleSilicon && globalConfig.embedMode === "gpu") {
      await this.ensureMlxServer(globalConfig.mlxModel);
    }

    // 7. Register daemon (only after resources are open)
    registerDaemon(process.pid);

    // 8. Subscribe to all registered projects (skip missing directories)
    const allProjects = listProjects();
    const indexed = allProjects.filter((p) => p.status === "indexed");
    for (const p of indexed) {
      if (!fs.existsSync(p.root)) {
        console.log(`[daemon] Skipping ${path.basename(p.root)} — directory not found`);
        continue;
      }
      try {
        await this.watchProject(p.root);
      } catch (err) {
        console.error(`[daemon] Failed to watch ${path.basename(p.root)}:`, err);
      }
    }

    // 8b. Index pending/error projects in the background, serialized to avoid
    // racing on shared LanceDB table creation (only one ensureTable() may win the
    // first createTable; the rest crash with "Table 'chunks' already exists").
    // Re-check shuttingDown each iteration: shutdown's pendingLocks drain is a
    // snapshot, so a new project op kicked off after the snapshot would race
    // with vectorDb.close() and fail with "VectorDB connection is closed".
    const pending = allProjects.filter(
      (p) => (p.status === "pending" || p.status === "error") && fs.existsSync(p.root),
    );
    void (async () => {
      for (const p of pending) {
        if (this.shuttingDown) return;
        try {
          await this.indexPendingProject(p.root);
        } catch (err) {
          console.error(`[daemon] Failed to index pending ${path.basename(p.root)}:`, err);
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
        void this.checkMlxHealth();
        this.sweepOrphanWorkers();
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
      console.log("[daemon] Idle shutdown disabled (GMAX_DAEMON_IDLE_TIMEOUT_MS<=0)");
    }

    console.log(`[daemon] Started (PID: ${process.pid}, ${this.processors.size} projects)`);

    // Pre-warm the search hot path so the first user-facing search doesn't
    // pay daemon-side cold costs:
    //   - LanceDB connection open + first openTable() (~10–15s on a 5GB
    //     index — this is the dominant cost)
    //   - FTS index "already exists" round-trip
    //   - Two parallel encodeQuery calls so the worker pool spawns + warms
    //     two workers (the reaper keeps min 2 alive). With one worker busy
    //     on a long indexing batch, the second is always free for searches.
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
          console.log(`[daemon] Search hot path pre-warmed (${Date.now() - t0}ms)`);
        } catch (err) {
          console.log(`[daemon] Search warmup failed (non-fatal): ${err}`);
        }
      })();
    }, 5000).unref();
  }

  async watchProject(root: string): Promise<void> {
    if (this.processors.has(root) || this.pendingOps.has(root)) return;
    if (!this.vectorDb || !this.metaCache) return;
    this.pendingOps.add(root);

    const processor = new ProjectBatchProcessor({
      projectRoot: root,
      vectorDb: this.vectorDb,
      metaCache: this.metaCache,
      onReindex: async (files, ms) => {
        console.log(
          `[daemon:${path.basename(root)}] Reindexed ${files} file${files !== 1 ? "s" : ""} (${(ms / 1000).toFixed(1)}s)`,
        );
        // Update project registry so gmax status shows fresh data
        const proj = getProject(root);
        if (proj) {
          let chunkCount = proj.chunkCount;
          try {
            chunkCount = await this.vectorDb!.countRowsForPath(root);
          } catch (err) {
            console.warn(`[daemon:${path.basename(root)}] Failed to query chunk count: ${err}`);
          }
          registerProject({
            ...proj,
            lastIndexed: new Date().toISOString(),
            chunkCount,
          });
        }
        // Back to watching after batch completes
        registerWatcher({
          pid: process.pid,
          projectRoot: root,
          startTime: Date.now(),
          status: "watching",
          lastHeartbeat: Date.now(),
          lastReindex: Date.now(),
        });
      },
      onActivity: () => {
        this.lastActivity = Date.now();
        // Mark as syncing while processing
        registerWatcher({
          pid: process.pid,
          projectRoot: root,
          startTime: Date.now(),
          status: "syncing",
          lastHeartbeat: Date.now(),
        });
      },
    });

    this.processors.set(root, processor);

    // Subscribe with @parcel/watcher — native backend, no polling.
    // If the kernel refuses (e.g. FSEvents slots stuck after a prior kill -9),
    // fall straight through to poll mode. The retry/backoff path inside
    // recoverWatcher is for transient overflows, not hard kernel-level
    // subscribe failures, so we skip it on startup by priming failCount past
    // MAX before invoking it.
    try {
      await this.subscribeWatcher(root, processor);
    } catch (err) {
      const name = path.basename(root);
      console.error(
        `[daemon:${name}] Subscribe failed at startup (${err instanceof Error ? err.message : err}) — switching to poll mode`,
      );
      this.watcherFailCount.set(root, 1_000); // > MAX_WATCHER_RETRIES
      this.lastOverflowMs.set(root, Date.now());
      this.recoverWatcher(root, processor);
    }


    registerWatcher({
      pid: process.pid,
      projectRoot: root,
      startTime: Date.now(),
      status: "watching",
      lastHeartbeat: Date.now(),
    });

    // Catchup scan — find files changed while daemon was offline
    this.catchupScan(root, processor).catch((err) => {
      console.error(`[daemon:${path.basename(root)}] Catchup scan failed:`, err);
    });

    this.pendingOps.delete(root);
    console.log(`[daemon] Watching ${root}`);
  }

  private async subscribeWatcher(root: string, processor: ProjectBatchProcessor): Promise<void> {
    const name = path.basename(root);

    // Unsubscribe existing watcher if any (e.g. during recovery)
    const existingSub = this.subscriptions.get(root);
    if (existingSub) {
      try { await existingSub.unsubscribe(); } catch {}
      this.subscriptions.delete(root);
    }

    const sub = await watcher.subscribe(
      root,
      (err, events) => {
        if (err) {
          console.error(`[daemon:${name}] Watcher error:`, err);
          this.recoverWatcher(root, processor);
          return;
        }
        // Only reset fail counter after sustained health (5min since last overflow)
        const lastOverflow = this.lastOverflowMs.get(root) ?? 0;
        if (Date.now() - lastOverflow > 5 * 60 * 1000) {
          this.watcherFailCount.delete(root);
        }
        for (const event of events) {
          processor.handleFileEvent(
            event.type === "delete" ? "unlink" : "change",
            event.path,
          );
        }
        this.lastActivity = Date.now();
      },
      { ignore: WATCHER_IGNORE_GLOBS },
    );
    this.subscriptions.set(root, sub);
  }

  private recoverWatcher(root: string, processor: ProjectBatchProcessor): void {
    const name = path.basename(root);
    if (this.shuttingDown) return;

    // Debounce: avoid multiple overlapping recovery attempts
    const recoveryKey = `recover:${root}`;
    if (this.pendingOps.has(recoveryKey)) return;
    this.pendingOps.add(recoveryKey);

    const fails = (this.watcherFailCount.get(root) ?? 0) + 1;
    this.watcherFailCount.set(root, fails);
    this.lastOverflowMs.set(root, Date.now());

    const MAX_WATCHER_RETRIES = 3;
    const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    if (fails > MAX_WATCHER_RETRIES) {
      // FSEvents can't handle this project — degrade to periodic catchup scans
      // Always tear down the broken sub, even if poll mode is already active —
      // this can happen if a recovery attempt resubscribed successfully then
      // re-overflowed during the 5-min health window.
      const sub = this.subscriptions.get(root);
      if (sub) {
        sub.unsubscribe().catch(() => {});
        this.subscriptions.delete(root);
      }
      if (!this.pollIntervals.has(root)) {
        console.error(`[daemon:${name}] FSEvents unreliable after ${fails} failures — switching to poll mode (${POLL_INTERVAL_MS / 60000}min interval)`);
        // Run an immediate catchup, then schedule periodic ones
        this.catchupScan(root, processor).catch((err) => {
          console.error(`[daemon:${name}] Poll catchup failed:`, err);
        });
        const interval = setInterval(() => {
          if (this.shuttingDown) return;
          this.lastActivity = Date.now();
          this.catchupScan(root, processor).catch((err) => {
            console.error(`[daemon:${name}] Poll catchup failed:`, err);
          });
        }, POLL_INTERVAL_MS);
        this.pollIntervals.set(root, interval);
        // Schedule periodic attempts to climb back to native FSEvents — after
        // a transient burst (large git checkout, npm install) the kernel
        // buffer often calms down within an hour.
        this.schedulePollModeRecovery(root, processor);
        registerWatcher({
          pid: process.pid,
          projectRoot: root,
          startTime: Date.now(),
          status: "watching",
          lastHeartbeat: Date.now(),
        });
      }
      this.pendingOps.delete(recoveryKey);
      return;
    }

    // Backoff: wait before re-subscribing (3s, 6s, 12s)
    const delayMs = 3000 * Math.pow(2, fails - 1);
    console.error(`[daemon:${name}] Recovering watcher (attempt ${fails}/${MAX_WATCHER_RETRIES}, backoff ${delayMs}ms)...`);

    setTimeout(() => {
      if (this.shuttingDown) { this.pendingOps.delete(recoveryKey); return; }
      (async () => {
        try {
          await this.subscribeWatcher(root, processor);
          const lastCatchup = this.lastCatchupEndMs.get(root) ?? 0;
          const CATCHUP_COOLDOWN_MS = 60_000;
          if (Date.now() - lastCatchup < CATCHUP_COOLDOWN_MS) {
            console.log(`[daemon:${name}] Skipping catchup scan (last completed ${Math.round((Date.now() - lastCatchup) / 1000)}s ago)`);
          } else {
            await this.catchupScan(root, processor);
          }
          console.log(`[daemon:${name}] Watcher recovered`);
        } catch (err) {
          console.error(`[daemon:${name}] Watcher recovery failed:`, err);
        } finally {
          this.pendingOps.delete(recoveryKey);
        }
      })();
    }, delayMs);
  }

  /**
   * Once a project has fallen back to poll mode, periodically try to upgrade
   * back to native FSEvents. The buffer overflows that triggered the fallback
   * are usually transient (big git checkout, npm install, build output) — no
   * point staying in 5-min poll mode forever.
   */
  private schedulePollModeRecovery(
    root: string,
    processor: ProjectBatchProcessor,
  ): void {
    if (this.pollRecoveryTimers.has(root)) return;
    const name = path.basename(root);
    const timer = setInterval(() => {
      if (this.shuttingDown) return;
      // Skip if a watcher recovery is already in flight or we're not in poll mode anymore.
      if (!this.pollIntervals.has(root)) {
        const t = this.pollRecoveryTimers.get(root);
        if (t) clearInterval(t);
        this.pollRecoveryTimers.delete(root);
        return;
      }
      if (this.pendingOps.has(`recover:${root}`)) return;

      void (async () => {
        console.log(`[daemon:${name}] Attempting to leave poll mode and reattach FSEvents...`);
        try {
          // Reset failure counter so subscribeWatcher's error path treats this
          // as a fresh start. If it fails again, we'll fall right back into
          // poll mode via the same recoverWatcher path.
          this.watcherFailCount.delete(root);
          await this.subscribeWatcher(root, processor);

          // Wait one health window — if the new subscription survives without
          // another overflow, we consider it recovered and tear down poll mode.
          await new Promise((r) => setTimeout(r, FSEVENTS_HEALTH_WINDOW_MS));
          if (this.shuttingDown) return;

          const lastOverflow = this.lastOverflowMs.get(root) ?? 0;
          if (Date.now() - lastOverflow < FSEVENTS_HEALTH_WINDOW_MS) {
            console.log(`[daemon:${name}] FSEvents recovery aborted — fresh overflow within health window, staying in poll mode`);
            return; // recoverWatcher will have re-armed poll mode if needed
          }

          // Healthy — drop poll mode.
          const pollInterval = this.pollIntervals.get(root);
          if (pollInterval) {
            clearInterval(pollInterval);
            this.pollIntervals.delete(root);
          }
          const recoveryTimer = this.pollRecoveryTimers.get(root);
          if (recoveryTimer) {
            clearInterval(recoveryTimer);
            this.pollRecoveryTimers.delete(root);
          }
          console.log(`[daemon:${name}] FSEvents recovered — poll mode disabled`);
        } catch (err) {
          console.error(`[daemon:${name}] Poll-mode recovery attempt failed:`, err);
        }
      })();
    }, FSEVENTS_RECOVERY_INTERVAL_MS);
    timer.unref();
    this.pollRecoveryTimers.set(root, timer);
  }

  private async catchupScan(root: string, processor: ProjectBatchProcessor): Promise<void> {
    const { walk } = await import("../index/walker");
    const { INDEXABLE_EXTENSIONS, MAX_FILE_SIZE_BYTES } = await import("../../config");
    const { isFileCached } = await import("../utils/cache-check");

    const rootPrefix = root.endsWith("/") ? root : `${root}/`;
    const cachedPaths = await this.metaCache!.getKeysWithPrefix(rootPrefix);
    const seenPaths = new Set<string>();

    let queued = 0;
    let skipped = 0;
    let debugSamples = 0;
    for await (const relPath of walk(root, {
      additionalPatterns: ["**/.git/**", "**/.gmax/**"],
    })) {
      const absPath = path.join(root, relPath);
      const ext = path.extname(absPath).toLowerCase();
      const bn = path.basename(absPath).toLowerCase();
      if (!INDEXABLE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(bn)) continue;

      seenPaths.add(absPath);

      try {
        const stats = await fs.promises.stat(absPath);
        // Skip files that are too large or empty — they'll never be indexed
        if (stats.size === 0 || stats.size > MAX_FILE_SIZE_BYTES) continue;
        const cached = this.metaCache!.get(absPath);
        if (!isFileCached(cached, stats)) {
          // Fast path: if only mtime changed but size is identical and we have a hash,
          // just verify the hash in-process instead of sending to a worker.
          if (cached && cached.hash && cached.size === stats.size) {
            const { computeBufferHash } = await import("../utils/file-utils");
            const buf = await fs.promises.readFile(absPath);
            const hash = computeBufferHash(buf);
            if (hash === cached.hash) {
              // Content unchanged — update mtime in cache and skip worker
              this.metaCache!.put(absPath, { ...cached, mtimeMs: stats.mtimeMs });
              skipped++;
              continue;
            }
          }
          // Debug: log first few misses to diagnose re-queue loops
          if (debugSamples < 5) {
            dbg("catchup", `miss ${relPath}: cached=${cached ? `mtime=${Math.trunc(cached.mtimeMs)} size=${cached.size}` : "null"} stat=mtime=${Math.trunc(stats.mtimeMs)} size=${stats.size}`);
            debugSamples++;
          }
          processor.handleFileEvent("change", absPath);
          queued++;

          // Throttle: pause periodically during large catchup scans to let the
          // batch processor drain and compaction run between bursts.
          if (queued % 500 === 0) {
            dbg("catchup", `${path.basename(root)}: throttle pause at ${queued} queued`);
            await new Promise(r => setTimeout(r, 5_000));
          }
        } else {
          skipped++;
        }
      } catch {}
    }
    dbg("catchup", `${path.basename(root)}: ${queued} queued, ${skipped} skipped (cached ok), ${seenPaths.size} total`);

    // Purge files deleted while daemon was offline
    let purged = 0;
    for (const cachedPath of cachedPaths) {
      if (!seenPaths.has(cachedPath)) {
        processor.handleFileEvent("unlink", cachedPath);
        purged++;
      }
    }

    if (queued > 0 || purged > 0) {
      const parts: string[] = [];
      if (queued > 0) parts.push(`${queued} changed`);
      if (purged > 0) parts.push(`${purged} deleted`);
      console.log(`[daemon:${path.basename(root)}] Catchup: ${parts.join(", ")} file(s) while offline`);
    }

    this.lastCatchupEndMs.set(root, Date.now());
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
          onProgress: () => { this.resetActivity(); },
        });

        const proj = getProject(root);
        if (proj) {
          registerProject({
            ...proj,
            lastIndexed: new Date().toISOString(),
            chunkCount: result.indexed,
            status: "indexed",
          });
        }

        await this.watchProject(root);
        dlog("daemon", `indexPendingProject done: ${name} — ${result.total} files, ${result.indexed} chunks, ${Date.now() - start}ms`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[daemon] indexPendingProject failed for ${name} after ${Date.now() - start}ms: ${msg}`);
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
    const processor = this.processors.get(root);
    if (!processor) return;

    await processor.close();

    const sub = this.subscriptions.get(root);
    if (sub) {
      await sub.unsubscribe();
      this.subscriptions.delete(root);
    }

    this.processors.delete(root);
    this.searchers.delete(root);
    this.lastOverflowMs.delete(root);
    this.lastCatchupEndMs.delete(root);
    unregisterWatcherByRoot(root);

    console.log(`[daemon] Unwatched ${root}`);
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
      indexing:
        !!fullIdx || processing || batchPending > 0 || initialPending,
      pendingFiles,
    };
  }

  async search(
    payload: {
      projectRoot: string;
      query: string;
      limit: number;
      filters?: SearchFilter;
      pathPrefix?: string;
      rerank?: boolean;
      explain?: boolean;
      seeds?: { files?: string[]; symbols?: string[] };
      includeSkeletons?: boolean;
      skeletonLimit?: number;
      includeGraph?: boolean;
    },
    signal: AbortSignal,
  ): Promise<{
    ok: boolean;
    data?: ChunkType[];
    warnings?: string[];
    skeletons?: Record<string, string>;
    graph?: unknown;
    indexState?: IndexState;
    error?: string;
    hint?: string;
  }> {
    if (!this.vectorDb) {
      return { ok: false, error: "daemon not ready" };
    }
    const root = payload.projectRoot;
    if (!this.processors.has(root)) {
      // A full index (--reset) or the initial index removes/defers the
      // processor while (re)building. The partial index is still queryable, so
      // answer the search and flag it partial (below) rather than erroring —
      // only truly-unwatched, not-indexing projects get "not watched".
      const indexingNow =
        this.indexProgress.has(root) || getProject(root)?.status === "pending";
      if (!indexingNow) {
        return {
          ok: false,
          error: "project not watched",
          hint: `run: gmax add ${root}`,
        };
      }
    }

    let searcher = this.searchers.get(root);
    if (!searcher) {
      searcher = new Searcher(this.vectorDb);
      this.searchers.set(root, searcher);
    }

    this.lastActivity = Date.now();

    let result;
    try {
      result = await searcher.search(
        payload.query,
        payload.limit,
        {
          rerank: payload.rerank === true,
          explain: payload.explain === true,
          seeds: payload.seeds,
        },
        payload.filters,
        payload.pathPrefix,
        undefined,
        signal,
      );
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        return { ok: false, error: "aborted" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "search_failed", hint: msg };
    }

    const response: {
      ok: boolean;
      data: ChunkType[];
      warnings?: string[];
      skeletons?: Record<string, string>;
      graph?: unknown;
      indexState?: IndexState;
    } = { ok: true, data: result.data };
    if (result.warnings?.length) response.warnings = result.warnings;

    // Annotate partial results when the index is still catching up, so an
    // agent can caveat or retry. Only attached when actually indexing (the
    // formatter suppresses the settled case anyway).
    const idx = this.indexState(root);
    if (idx.indexing) response.indexState = idx;

    // --skeleton support: fetch per-file skeletons inline so the CLI doesn't
    // have to open its own VectorDB. getStoredSkeleton is a single LIMIT-1
    // lookup; cheap enough to call for the top N distinct paths.
    if (payload.includeSkeletons && result.data.length > 0) {
      const limit = payload.skeletonLimit && payload.skeletonLimit > 0 ? payload.skeletonLimit : 5;
      const seen = new Set<string>();
      const skeletons: Record<string, string> = {};
      for (const chunk of result.data) {
        const p =
          (chunk as unknown as { path?: string }).path ??
          (chunk.metadata?.path as string | undefined);
        if (!p || seen.has(p)) continue;
        seen.add(p);
        if (seen.size > limit) break;
        try {
          const sk = await getStoredSkeleton(this.vectorDb, p);
          if (sk) skeletons[p] = sk;
        } catch {
          // best-effort — drop the entry, keep the search result
        }
      }
      if (Object.keys(skeletons).length > 0) response.skeletons = skeletons;
    }

    // --symbol support: build a 1-hop graph using the warm vectorDb. ~5
    // LanceDB queries; doesn't touch the worker pool.
    if (payload.includeGraph) {
      try {
        const { GraphBuilder } = await import("../graph/graph-builder");
        const builder = new GraphBuilder(this.vectorDb, root);
        response.graph = await builder.buildGraphMultiHop(payload.query, 1);
      } catch {
        // best-effort — drop graph, keep results
      }
    }

    // 2 MB cap on the JSON line. Lance can return huge chunks for unusual
    // queries (very long markdown blobs). Above this we fall back to the
    // in-process path which writes to stdout instead of a socket.
    const serialized = JSON.stringify(response);
    if (serialized.length > 2 * 1024 * 1024) {
      return {
        ok: false,
        error: "oversize",
        hint: `${serialized.length} bytes — falling back to in-process search`,
      };
    }
    return response;
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

  private async withProjectLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.projectLocks.get(root) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
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
        console.error(`[daemon] addProject failed for ${path.basename(root)}:`, msg);
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
        console.error(`[daemon] indexProject failed for ${path.basename(root)}:`, msg);
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
            console.error(`[daemon] Failed to re-watch ${path.basename(root)}:`, err);
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
        console.error(`[daemon] removeProject failed for ${path.basename(root)}:`, msg);
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

      const rootPrefix = opts.pathPrefix ?? (root.endsWith("/") ? root : `${root}/`);

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
        console.error(`[daemon] summarizeProject failed for ${path.basename(root)}:`, msg);
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

  // --- MLX embed server management ---

  private async isMlxServerUp(): Promise<boolean> {
    const port = parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
    return new Promise<boolean>((resolve) => {
      const req = http.get(
        { hostname: "127.0.0.1", port, path: "/health", timeout: 2000 },
        (res) => { res.resume(); resolve(res.statusCode === 200); },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
  }

  private getPortPid(port: number): number | null {
    try {
      const out = execSync(`lsof -ti :${port}`, { timeout: 5000 }).toString().trim();
      const pid = parseInt(out.split("\n")[0], 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  private async checkMlxHealth(): Promise<void> {
    if (this.shuttingDown || this.mlxRecoveryInFlight) return;
    if (await this.isMlxServerUp()) return;
    const port = parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
    const stalePid = this.getPortPid(port);
    if (!stalePid) return; // No process — let the next user-facing path spawn it.
    this.mlxRecoveryInFlight = true;
    try {
      console.log(
        `[daemon] MLX zombie detected on port ${port} (PID ${stalePid}) — killing and respawning`,
      );
      await killProcess(stalePid);
      await new Promise((r) => setTimeout(r, 500));
      await this.ensureMlxServer();
    } catch (err) {
      console.error(
        `[daemon] MLX recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.mlxRecoveryInFlight = false;
    }
  }

  private async ensureMlxServer(mlxModel?: string): Promise<void> {
    if (await this.isMlxServerUp()) {
      console.log("[daemon] MLX embed server already running");
      return;
    }

    // Kill stale process holding the port (orphaned from a previous daemon)
    const port = parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
    const stalePid = this.getPortPid(port);
    if (stalePid) {
      console.log(`[daemon] Killing stale MLX process on port ${port} (PID: ${stalePid})`);
      await killProcess(stalePid);
      // Brief pause for OS to release the port
      await new Promise((r) => setTimeout(r, 500));
    }

    // Find mlx-embed-server/server.py relative to the grepmax package
    const candidates = [
      path.resolve(__dirname, "../../../mlx-embed-server"),
      path.resolve(__dirname, "../../mlx-embed-server"),
    ];
    const serverDir = candidates.find((d) =>
      fs.existsSync(path.join(d, "server.py")),
    );
    if (!serverDir) {
      console.warn("[daemon] MLX embed server not found — falling back to CPU embeddings");
      return;
    }

    const logFd = openRotatedLog(path.join(PATHS.logsDir, "mlx-embed-server.log"));
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (mlxModel) env.MLX_EMBED_MODEL = mlxModel;

    this.mlxChild = spawn("uv", ["run", "python", "server.py"], {
      cwd: serverDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env,
    });
    this.mlxChild.unref();
    console.log(`[daemon] Starting MLX embed server (PID: ${this.mlxChild.pid})`);

    // Poll for readiness (up to 30s)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await this.isMlxServerUp()) {
        console.log("[daemon] MLX embed server ready");
        return;
      }
    }
    console.error("[daemon] MLX embed server failed to start within 30s — falling back to CPU embeddings");
    this.mlxChild = null;
  }

  private stopMlxServer(): void {
    // The spawned process is `uv`, which forks `python` then exits. Killing the
    // recorded PID alone leaves python orphaned (the orphan source for port 8100
    // collisions across daemon restarts). Always also kill whoever owns the port.
    if (this.mlxChild?.pid) {
      try {
        process.kill(-this.mlxChild.pid, "SIGTERM");
      } catch {
        try { process.kill(this.mlxChild.pid, "SIGTERM"); } catch {}
      }
      console.log(`[daemon] Stopped MLX embed server (PID: ${this.mlxChild.pid})`);
      this.mlxChild = null;
    }
    const port = parseInt(process.env.MLX_EMBED_PORT || "8100", 10);
    const portOwner = this.getPortPid(port);
    if (portOwner) {
      try {
        process.kill(portOwner, "SIGTERM");
        console.log(`[daemon] Killed orphan MLX on port ${port} (PID: ${portOwner})`);
      } catch {}
    }
  }

  /**
   * Find and kill all stale gmax-daemon and gmax-worker processes.
   * Uses pgrep to scan by process title rather than relying solely on
   * the PID file, which becomes stale when a daemon is orphaned through
   * the lock-compromise path.
   */
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
    console.log(`[daemon] Recycling (${reason}) — handing off to a fresh daemon`);
    this.recycling = true;
    void this.shutdown({ relaunch: true }).finally(() => process.exit(0));
  }

  /**
   * Kill gmax-worker processes that are children of THIS daemon but the worker
   * pool no longer tracks — strays left behind if a kill ever failed silently.
   * Filters by parent PID so a per-project `gmax watch`'s own workers are never
   * touched. Requires a worker to look orphaned on two consecutive sweeps so a
   * just-forked worker can't be killed by a snapshot race.
   */
  private sweepOrphanWorkers(): void {
    if (this.shuttingDown || !isWorkerPoolInitialized()) return;
    const tracked = new Set(getWorkerPool().getWorkerPids());
    const workerPids = new Set(this.findProcessesByTitle("gmax-worker"));
    const ourChildren = this.findChildPids();
    const orphans = ourChildren.filter(
      (pid) => workerPids.has(pid) && !tracked.has(pid),
    );

    const confirmed = orphans.filter((pid) => this.suspectedOrphanWorkers.has(pid));
    this.suspectedOrphanWorkers = new Set(orphans);

    for (const pid of confirmed) {
      console.log(`[daemon] Killing orphan worker PID:${pid} (untracked by pool)`);
      try { process.kill(pid, "SIGKILL"); } catch {}
      this.suspectedOrphanWorkers.delete(pid);
    }
  }

  /** Child PIDs of this process (workers, MLX, llama-server). */
  private findChildPids(): number[] {
    try {
      const out = execSync(`pgrep -P ${process.pid}`, {
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
      if (!out) return [];
      return out
        .split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      return [];
    }
  }

  private async killStaleProcesses(): Promise<void> {
    // 1. Check for other daemon processes
    const daemonPids = this.findProcessesByTitle("gmax-daemon")
      .filter((pid) => pid !== process.pid);
    const workerPids = this.findProcessesByTitle("gmax-worker");

    if (daemonPids.length === 0 && workerPids.length === 0) {
      dlog("daemon", "No stale processes found");
      return;
    }

    for (const pid of daemonPids) {
      dlog("daemon", `found daemon PID:${pid}, checking liveness...`);

      // A busy daemon (mid-index, compaction, big LMDB write) can block the
      // event loop long enough to miss a ping. Two independent liveness
      // probes — if either says "alive", defer to the running peer instead
      // of killing its workers mid-flight.
      //   1. daemon.lock mtime (refreshed by heartbeat every 60s)
      //   2. socket ping with a generous 10s timeout
      const heartbeatFresh = isDaemonHeartbeatFresh();
      const responsive = await isDaemonRunning({ timeoutMs: 10_000 });

      if (heartbeatFresh || responsive) {
        dlog(
          "daemon",
          `existing daemon PID:${pid} is alive (heartbeat=${heartbeatFresh} ping=${responsive}) — exiting`,
        );
        process.exit(0);
      }
      dlog("daemon", `stale daemon PID:${pid} unresponsive and heartbeat stale — killing`);
      await killProcess(pid);
      dlog("daemon", `killed stale daemon PID:${pid}`);
    }

    // 2. Kill orphaned workers from previous daemon instances.
    // Safe because this runs before the new daemon's worker pool is initialized.
    for (const pid of workerPids) {
      dlog("daemon", `killing orphaned worker PID:${pid}`);
      await killProcess(pid);
    }

    dlog("daemon", `Cleaned up ${daemonPids.length} stale daemon(s), ${workerPids.length} orphaned worker(s)`);
  }

  private findProcessesByTitle(title: string): number[] {
    try {
      const out = execSync(`pgrep -x "${title}"`, {
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
      if (!out) return [];
      return out
        .split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      // pgrep exits 1 when no processes match — not an error
      return [];
    }
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
    try { fs.unlinkSync(PATHS.daemonSocket); } catch {}
    try { fs.unlinkSync(PATHS.daemonPidFile); } catch {}
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
      console.log(`[daemon] Waiting for ${pendingLocks.length} in-flight operation(s)...`);
      await Promise.allSettled(pendingLocks);
    }

    // Close all processors
    for (const processor of this.processors.values()) {
      await processor.close();
    }

    // Stop LLM server if running
    try { await this.llmServer?.stop(); } catch {}

    // Stop MLX embed server if we started it
    this.stopMlxServer();

    // Destroy worker pool to prevent orphaned child processes
    if (isWorkerPoolInitialized()) {
      try { await destroyWorkerPool(); } catch {}
    }

    // Stop poll intervals + their FSEvents recovery probes
    for (const interval of this.pollIntervals.values()) {
      clearInterval(interval);
    }
    this.pollIntervals.clear();
    for (const interval of this.pollRecoveryTimers.values()) {
      clearInterval(interval);
    }
    this.pollRecoveryTimers.clear();

    // Unsubscribe all watchers
    for (const sub of this.subscriptions.values()) {
      try { await sub.unsubscribe(); } catch {}
    }
    this.subscriptions.clear();

    // Close server (socket/pid/lock already dropped at the top of shutdown)
    this.server?.close();

    // Unregister all
    for (const root of this.processors.keys()) {
      unregisterWatcherByRoot(root);
    }
    unregisterDaemon();
    this.processors.clear();

    // Close shared resources
    try { await this.metaCache?.close(); } catch {}
    try { await this.vectorDb?.close(); } catch {}

    // Hand off to a successor only after every resource is released and the
    // liveness markers (socket/pid/lock) are already gone — so the fresh
    // daemon's singleton check sees a clean slate and opens LanceDB/LMDB
    // without contending with this exiting process.
    if (opts.relaunch) {
      const pid = spawnDaemon();
      console.log(`[daemon] Spawned successor daemon${pid ? ` (PID: ${pid})` : " (spawn failed)"}`);
    }

    console.log("[daemon] Shutdown complete");
  }
}
