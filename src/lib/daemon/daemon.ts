import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { PATHS } from "../../config";
import { ProjectBatchProcessor } from "../index/batch-processor";
import { WATCHER_IGNORE_PATTERNS } from "../index/watcher";
import { MetaCache } from "../store/meta-cache";
import { VectorDB } from "../store/vector-db";
import { killProcess } from "../utils/process";
import { listProjects } from "../utils/project-registry";
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
  private watcher: FSWatcher | null = null;
  private readonly processors = new Map<string, ProjectBatchProcessor>();
  private vectorDb: VectorDB | null = null;
  private metaCache: MetaCache | null = null;
  private server: net.Server | null = null;
  private lastActivity = Date.now();
  private readonly startTime = Date.now();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private idleInterval: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  // Sorted longest-first for prefix matching
  private sortedRoots: string[] = [];
  // Guard against concurrent watchProject/unwatchProject
  private readonly pendingOps = new Set<string>();

  async start(): Promise<void> {
    // 1. Kill existing per-project watchers
    const existing = listWatchers();
    for (const w of existing) {
      console.log(`[daemon] Taking over from per-project watcher (PID: ${w.pid}, ${path.basename(w.projectRoot)})`);
      await killProcess(w.pid);
      unregisterWatcher(w.pid);
    }

    // 2. Stale socket cleanup
    try { fs.unlinkSync(PATHS.daemonSocket); } catch {}

    // 3. Open shared resources
    try {
      fs.mkdirSync(PATHS.cacheDir, { recursive: true });
      fs.mkdirSync(PATHS.lancedbDir, { recursive: true });
      this.vectorDb = new VectorDB(PATHS.lancedbDir);
      this.metaCache = new MetaCache(PATHS.lmdbPath);
    } catch (err) {
      console.error("[daemon] Failed to open shared resources:", err);
      throw err;
    }

    // 4. Register daemon (only after resources are open)
    registerDaemon(process.pid);

    // 5. Load registered projects and create processors
    const projects = listProjects().filter((p) => p.status === "indexed");
    const initialRoots: string[] = [];
    for (const p of projects) {
      this.addProcessor(p.root);
      initialRoots.push(p.root);
    }

    // 6. Create chokidar with all initial roots
    // Daemon always uses polling — watching multiple large project trees
    // with native fs.watch can exhaust file descriptors even on macOS.
    // Polling at 5s intervals is lightweight and reliable for all platforms.
    this.watcher = watch(initialRoots, {
      ignored: WATCHER_IGNORE_PATTERNS,
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 5000,
      binaryInterval: 10000,
    });

    this.watcher.on("add", (p) => this.routeEvent("change", p));
    this.watcher.on("change", (p) => this.routeEvent("change", p));
    this.watcher.on("unlink", (p) => this.routeEvent("unlink", p));
    this.watcher.on("error", (err) => {
      console.error("[daemon] Watcher error:", err);
    });

    // 7. Heartbeat
    this.heartbeatInterval = setInterval(() => {
      heartbeat(process.pid);
    }, HEARTBEAT_INTERVAL_MS);

    // 8. Idle timeout
    this.idleInterval = setInterval(() => {
      if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) {
        console.log("[daemon] Idle for 30 minutes, shutting down");
        this.shutdown();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // 9. Socket server
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
      conn.on("error", () => {}); // ignore client disconnect
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE") {
          console.error("[daemon] Another daemon is already running");
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
    if (!this.watcher) return;

    this.addProcessor(root);
    this.watcher.add(root);

    console.log(`[daemon] Watching ${root}`);
  }

  private addProcessor(root: string): void {
    if (this.processors.has(root)) return;
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
      },
      onActivity: () => {
        this.lastActivity = Date.now();
      },
    });

    this.processors.set(root, processor);
    this.rebuildSortedRoots();

    registerWatcher({
      pid: process.pid,
      projectRoot: root,
      startTime: Date.now(),
      status: "watching",
      lastHeartbeat: Date.now(),
    });

    this.pendingOps.delete(root);
  }

  async unwatchProject(root: string): Promise<void> {
    const processor = this.processors.get(root);
    if (!processor) return;

    await processor.close();
    this.watcher?.unwatch(root);
    this.processors.delete(root);
    this.rebuildSortedRoots();
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

    // Close chokidar
    try { await this.watcher?.close(); } catch {}

    // Close server + socket
    this.server?.close();
    try { fs.unlinkSync(PATHS.daemonSocket); } catch {}

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

  private routeEvent(event: "change" | "unlink", absPath: string): void {
    const processor = this.findProcessor(absPath);
    if (processor) {
      processor.handleFileEvent(event, absPath);
    }
  }

  private findProcessor(absPath: string): ProjectBatchProcessor | undefined {
    // sortedRoots is longest-first, so first match is the most specific
    for (const root of this.sortedRoots) {
      if (absPath.startsWith(root) && (absPath.length === root.length || absPath[root.length] === "/")) {
        return this.processors.get(root);
      }
    }
    return undefined;
  }

  private rebuildSortedRoots(): void {
    this.sortedRoots = [...this.processors.keys()].sort(
      (a, b) => b.length - a.length,
    );
  }
}
