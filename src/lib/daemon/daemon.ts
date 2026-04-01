import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as watcher from "@parcel/watcher";
import type { AsyncSubscription } from "@parcel/watcher";
import lockfile from "proper-lockfile";
import { PATHS } from "../../config";
import { ProjectBatchProcessor } from "../index/batch-processor";
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
import { handleCommand } from "./ipc-handler";

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
      this.metaCache = new MetaCache(PATHS.lmdbPath);
    } catch (err) {
      console.error("[daemon] Failed to open shared resources:", err);
      throw err;
    }

    // 6. Register daemon (only after resources are open)
    registerDaemon(process.pid);

    // 7. Subscribe to all registered projects (skip missing directories)
    const projects = listProjects().filter((p) => p.status === "indexed");
    for (const p of projects) {
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
        handleCommand(this, cmd).then((resp) => {
          conn.write(`${JSON.stringify(resp)}\n`);
          conn.end();
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
      dataDir: PATHS.globalRoot,
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

    this.pendingOps.delete(root);
    console.log(`[daemon] Watching ${root}`);
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
