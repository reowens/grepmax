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
import { handleCommand, writeProgress, writeDone } from "./ipc-handler";
import { log as dlog, debug as dbg } from "../utils/logger";
import { isDaemonRunning } from "../utils/daemon-client";
import { isProcessRunning } from "../utils/watcher-store";
import { readGlobalConfig } from "../index/index-config";
import { openRotatedLog } from "../utils/log-rotate";
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

export class Daemon {
  private readonly processors = new Map<string, ProjectBatchProcessor>();
  private readonly subscriptions = new Map<string, AsyncSubscription>();
  private vectorDb: VectorDB | null = null;
  private metaCache: MetaCache | null = null;
  private server: net.Server | null = null;
  private releaseLock: (() => Promise<void>) | null = null;
  private lastActivity = Date.now();
  private readonly startTime = Date.now();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private idleInterval: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private readonly pendingOps = new Set<string>();
  private readonly watcherFailCount = new Map<string, number>();
  private readonly pollIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly projectLocks = new Map<string, Promise<void>>();
  private llmServer: LlmServer | null = null;
  private mlxChild: ChildProcess | null = null;

  async start(): Promise<void> {
    process.title = "gmax-daemon";

    // 0. Singleton enforcement: check PID file for existing daemon
    try {
      const pidStr = fs.readFileSync(PATHS.daemonPidFile, "utf-8").trim();
      const existingPid = parseInt(pidStr, 10);
      if (existingPid && existingPid !== process.pid && isProcessRunning(existingPid)) {
        dlog("daemon", `found existing daemon PID:${existingPid}, checking socket...`);
        const responsive = await isDaemonRunning();
        if (responsive) {
          dlog("daemon", "existing daemon is responsive — exiting");
          process.exit(0);
        }
        // Unresponsive but alive — kill it
        dlog("daemon", `existing daemon PID:${existingPid} unresponsive — killing`);
        await killProcess(existingPid);
        dlog("daemon", `killed stale daemon PID:${existingPid}`);
      }
    } catch {
      // No PID file or unreadable — proceed normally
    }

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
          this.shutdown();
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

    // 2. Kill existing per-project watchers
    const existing = listWatchers();
    for (const w of existing) {
      console.log(`[daemon] Taking over from per-project watcher (PID: ${w.pid}, ${path.basename(w.projectRoot)})`);
      await killProcess(w.pid);
      unregisterWatcher(w.pid);
    }

    // 3. Write PID file (informational only — lock is the real guard)
    fs.writeFileSync(PATHS.daemonPidFile, String(process.pid));

    // 4. Stale socket cleanup
    try { fs.unlinkSync(PATHS.daemonSocket); } catch {}

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

    // 8b. Index pending projects in the background
    const pending = allProjects.filter(
      (p) => p.status === "pending" && fs.existsSync(p.root),
    );
    for (const p of pending) {
      this.indexPendingProject(p.root).catch((err) => {
        console.error(`[daemon] Failed to index pending ${path.basename(p.root)}:`, err);
      });
    }

    // 9. Heartbeat + refresh lockfile mtime to prevent stale detection
    this.heartbeatInterval = setInterval(() => {
      heartbeat(process.pid);
      try {
        const now = new Date();
        fs.utimesSync(PATHS.daemonLockFile, now, now);
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);

    // 10. Idle timeout
    this.idleInterval = setInterval(() => {
      if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) {
        console.log("[daemon] Idle for 30 minutes, shutting down");
        this.shutdown();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // 11. Socket server
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

    console.log(`[daemon] Started (PID: ${process.pid}, ${this.processors.size} projects)`);
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

    // Subscribe with @parcel/watcher — native backend, no polling
    await this.subscribeWatcher(root, processor);


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
        // Watcher is healthy — reset fail counter
        this.watcherFailCount.delete(root);
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

    const MAX_WATCHER_RETRIES = 3;
    const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    if (fails > MAX_WATCHER_RETRIES) {
      // FSEvents can't handle this project — degrade to periodic catchup scans
      if (!this.pollIntervals.has(root)) {
        console.error(`[daemon:${name}] FSEvents unreliable after ${fails} failures — switching to poll mode (${POLL_INTERVAL_MS / 60000}min interval)`);
        // Unsubscribe the broken watcher
        const sub = this.subscriptions.get(root);
        if (sub) {
          sub.unsubscribe().catch(() => {});
          this.subscriptions.delete(root);
        }
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
          await this.catchupScan(root, processor);
          console.log(`[daemon:${name}] Watcher recovered`);
        } catch (err) {
          console.error(`[daemon:${name}] Watcher recovery failed:`, err);
        } finally {
          this.pendingOps.delete(recoveryKey);
        }
      })();
    }, delayMs);
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
  }

  private async indexPendingProject(root: string): Promise<void> {
    await this.withProjectLock(root, async () => {
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
    unregisterWatcherByRoot(root);

    console.log(`[daemon] Unwatched ${root}`);
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

      this.vectorDb.pauseMaintenanceLoop();
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

        await this.watchProject(root);

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
        writeDone(conn, { ok: false, error: msg });
      } finally {
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

      this.vectorDb.pauseMaintenanceLoop();
      let lastProgressTime = 0;
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
        writeDone(conn, { ok: false, error: msg });
      } finally {
        this.vectorDb?.resumeMaintenanceLoop();
        // Re-enable watcher
        try {
          await this.watchProject(root);
        } catch (err) {
          console.error(`[daemon] Failed to re-watch ${path.basename(root)}:`, err);
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

      try {
        await this.unwatchProject(root);

        const rootPrefix = root.endsWith("/") ? root : `${root}/`;
        await this.vectorDb.deletePathsWithPrefix(rootPrefix);

        const keys = await this.metaCache.getKeysWithPrefix(rootPrefix);
        for (const key of keys) {
          this.metaCache.delete(key);
        }

        writeDone(conn, { ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[daemon] removeProject failed for ${path.basename(root)}:`, msg);
        writeDone(conn, { ok: false, error: msg });
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
        console.error(`[daemon] summarizeProject failed for ${path.basename(root)}:`, msg);
        writeDone(conn, { ok: false, error: msg });
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

  private async ensureMlxServer(mlxModel?: string): Promise<void> {
    if (await this.isMlxServerUp()) {
      console.log("[daemon] MLX embed server already running");
      return;
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
    if (!this.mlxChild?.pid) return;
    try {
      process.kill(this.mlxChild.pid, "SIGTERM");
      console.log(`[daemon] Stopped MLX embed server (PID: ${this.mlxChild.pid})`);
    } catch {}
    this.mlxChild = null;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    console.log("[daemon] Shutting down...");

    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.idleInterval) clearInterval(this.idleInterval);

    // Close all processors
    for (const processor of this.processors.values()) {
      await processor.close();
    }

    // Stop LLM server if running
    try { await this.llmServer?.stop(); } catch {}

    // Stop MLX embed server if we started it
    this.stopMlxServer();

    // Stop poll intervals
    for (const interval of this.pollIntervals.values()) {
      clearInterval(interval);
    }
    this.pollIntervals.clear();

    // Unsubscribe all watchers
    for (const sub of this.subscriptions.values()) {
      try { await sub.unsubscribe(); } catch {}
    }
    this.subscriptions.clear();

    // Close server + socket + PID file + lock
    this.server?.close();
    try { fs.unlinkSync(PATHS.daemonSocket); } catch {}
    try { fs.unlinkSync(PATHS.daemonPidFile); } catch {}
    if (this.releaseLock) {
      try { await this.releaseLock(); } catch {}
      this.releaseLock = null;
    }

    // Unregister all
    for (const root of this.processors.keys()) {
      unregisterWatcherByRoot(root);
    }
    unregisterDaemon();
    this.processors.clear();

    // Close shared resources
    try { await this.metaCache?.close(); } catch {}
    try { await this.vectorDb?.close(); } catch {}

    console.log("[daemon] Shutdown complete");
  }
}
