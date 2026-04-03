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
  private readonly projectLocks = new Map<string, Promise<void>>();
  private llmServer: LlmServer | null = null;

  async start(): Promise<void> {
    process.title = "gmax-daemon";

    // 1. Acquire exclusive lock — kernel-enforced, atomic, auto-released on death
    fs.mkdirSync(path.dirname(PATHS.daemonLockFile), { recursive: true });
    fs.writeFileSync(PATHS.daemonLockFile, "", { flag: "a" }); // ensure file exists
    try {
      this.releaseLock = await lockfile.lock(PATHS.daemonLockFile, {
        retries: 0,
        stale: 30_000,
      });
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
      this.vectorDb = new VectorDB(PATHS.lancedbDir);
      this.vectorDb.startMaintenanceLoop();
      this.metaCache = new MetaCache(PATHS.lmdbPath);
    } catch (err) {
      console.error("[daemon] Failed to open shared resources:", err);
      throw err;
    }

    // 6. LLM server manager (constructed, not started — starts on first request)
    this.llmServer = new LlmServer();

    // 7. Register daemon (only after resources are open)
    registerDaemon(process.pid);

    // 7. Subscribe to all registered projects (skip missing directories)
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

    // 7b. Index pending projects in the background
    const pending = allProjects.filter(
      (p) => p.status === "pending" && fs.existsSync(p.root),
    );
    for (const p of pending) {
      this.indexPendingProject(p.root).catch((err) => {
        console.error(`[daemon] Failed to index pending ${path.basename(p.root)}:`, err);
      });
    }

    // 8. Heartbeat
    this.heartbeatInterval = setInterval(() => {
      heartbeat(process.pid);
    }, HEARTBEAT_INTERVAL_MS);

    // 9. Idle timeout
    this.idleInterval = setInterval(() => {
      if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) {
        console.log("[daemon] Idle for 30 minutes, shutting down");
        this.shutdown();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // 10. Socket server
    this.server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString();
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
      onReindex: (files, ms) => {
        console.log(
          `[daemon:${path.basename(root)}] Reindexed ${files} file${files !== 1 ? "s" : ""} (${(ms / 1000).toFixed(1)}s)`,
        );
        // Update project registry so gmax status shows fresh data
        const proj = getProject(root);
        if (proj) {
          registerProject({
            ...proj,
            lastIndexed: new Date().toISOString(),
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
    const sub = await watcher.subscribe(
      root,
      (err, events) => {
        if (err) {
          console.error(`[daemon:${path.basename(root)}] Watcher error:`, err);
          return;
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

  private async catchupScan(root: string, processor: ProjectBatchProcessor): Promise<void> {
    const { walk } = await import("../index/walker");
    const { INDEXABLE_EXTENSIONS } = await import("../../config");
    const { isFileCached } = await import("../utils/cache-check");

    let queued = 0;
    for await (const relPath of walk(root, {
      additionalPatterns: ["**/.git/**", "**/.gmax/**", "**/.osgrep/**"],
    })) {
      const absPath = path.join(root, relPath);
      const ext = path.extname(absPath).toLowerCase();
      const bn = path.basename(absPath).toLowerCase();
      if (!INDEXABLE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(bn)) continue;

      try {
        const stats = await fs.promises.stat(absPath);
        const cached = this.metaCache!.get(absPath);
        if (!isFileCached(cached, stats)) {
          processor.handleFileEvent("change", absPath);
          queued++;
        }
      } catch {}
    }

    if (queued > 0) {
      console.log(`[daemon:${path.basename(root)}] Catchup: ${queued} file(s) changed while offline`);
    }
  }

  private async indexPendingProject(root: string): Promise<void> {
    await this.withProjectLock(root, async () => {
      if (!this.vectorDb || !this.metaCache) return;

      console.log(`[daemon] Indexing pending project: ${path.basename(root)}`);
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
        console.log(
          `[daemon] Indexed ${path.basename(root)} (${result.total} files, ${result.indexed} chunks)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[daemon] indexPendingProject failed for ${path.basename(root)}: ${msg}`);
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
