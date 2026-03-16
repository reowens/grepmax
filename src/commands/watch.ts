import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { PATHS } from "../config";
import { initialSync } from "../lib/index/syncer";
import { startWatcher } from "../lib/index/watcher";
import { MetaCache } from "../lib/store/meta-cache";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  getWatcherForProject,
  isProcessRunning,
  listWatchers,
  registerWatcher,
  unregisterWatcher,
} from "../lib/utils/watcher-registry";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_CHECK_INTERVAL_MS = 60 * 1000; // check every minute

export const watch = new Command("watch")
  .description("Start background file watcher for live reindexing")
  .option("-b, --background", "Run watcher in background and exit")
  .option("-p, --path <dir>", "Directory to watch (defaults to project root)")
  .option("--no-idle-timeout", "Disable the 30-minute idle shutdown")
  .action(async (options: { background?: boolean; path?: string; idleTimeout?: boolean }) => {
    const projectRoot = options.path
      ? path.resolve(options.path)
      : findProjectRoot(process.cwd()) ?? process.cwd();
    const projectName = path.basename(projectRoot);

    // Check if watcher already running
    const existing = getWatcherForProject(projectRoot);
    if (existing && isProcessRunning(existing.pid)) {
      console.log(
        `Watcher already running for ${projectName} (PID: ${existing.pid})`,
      );
      return;
    }

    // Background spawn
    if (options.background) {
      const args = process.argv
        .slice(2)
        .filter((arg) => arg !== "-b" && arg !== "--background");

      const logDir = path.join(PATHS.globalRoot, "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const safeName = projectName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const logFile = path.join(logDir, `watch-${safeName}.log`);
      const out = fs.openSync(logFile, "a");

      const child = spawn(process.argv[0], [process.argv[1], ...args], {
        detached: true,
        stdio: ["ignore", out, out],
        cwd: process.cwd(),
        env: { ...process.env, GMAX_BACKGROUND: "true" },
      });
      child.unref();

      console.log(
        `Watcher started for ${projectName} (PID: ${child.pid}, log: ${logFile})`,
      );
      process.exit(0);
    }

    // --- Foreground mode ---
    const paths = ensureProjectPaths(projectRoot);

    // Propagate project root to worker processes
    process.env.GMAX_PROJECT_ROOT = paths.root;

    console.log(`[watch:${projectName}] Starting...`);

    // Initial sync if no index
    const vectorDb = new VectorDB(paths.lancedbDir);
    if (!(await vectorDb.hasAnyRows())) {
      console.log(
        `[watch:${projectName}] No index found, running initial sync...`,
      );
      await initialSync({ projectRoot });
      console.log(`[watch:${projectName}] Initial sync complete.`);
    }

    // Open resources for watcher
    const metaCache = new MetaCache(paths.lmdbPath);

    // Register
    registerWatcher({
      pid: process.pid,
      projectRoot,
      startTime: Date.now(),
    });

    // Start watching
    const watcher = startWatcher({
      projectRoot,
      vectorDb,
      metaCache,
      dataDir: paths.dataDir,
      onReindex: (files, ms) => {
        console.log(
          `[watch:${projectName}] Reindexed ${files} file${files !== 1 ? "s" : ""} (${(ms / 1000).toFixed(1)}s)`,
        );
        lastActivity = Date.now();
      },
    });

    console.log(`[watch:${projectName}] File watcher active`);

    // Idle timeout
    let lastActivity = Date.now();
    if (options.idleTimeout !== false) {
      setInterval(() => {
        if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
          console.log(
            `[watch:${projectName}] Idle for 30 minutes, shutting down`,
          );
          shutdown();
        }
      }, IDLE_CHECK_INTERVAL_MS);
    }

    // Graceful shutdown
    async function shutdown() {
      try {
        await watcher.close();
      } catch {}
      metaCache.close();
      await vectorDb.close();
      unregisterWatcher(process.pid);
      await gracefulExit();
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// --- Subcommands ---

watch
  .command("status")
  .description("Show running watchers")
  .action(async () => {
    const watchers = listWatchers();

    if (watchers.length === 0) {
      console.log("No running watchers.");
      await gracefulExit();
      return;
    }

    console.log("Running watchers:");
    for (const w of watchers) {
      const age = Math.floor((Date.now() - w.startTime) / 60000);
      console.log(
        `- PID: ${w.pid} | Root: ${w.projectRoot} | Running: ${age}m`,
      );
    }
    await gracefulExit();
  });

watch
  .command("stop")
  .description("Stop watcher for current project")
  .option("--all", "Stop all running watchers")
  .action(async (options: { all?: boolean }) => {
    if (options.all) {
      const watchers = listWatchers();
      for (const w of watchers) {
        try {
          process.kill(w.pid, "SIGTERM");
          unregisterWatcher(w.pid);
        } catch {}
      }
      console.log(`Stopped ${watchers.length} watcher(s).`);
      await gracefulExit();
      return;
    }

    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
    const watcher = getWatcherForProject(projectRoot);

    if (!watcher) {
      console.log("No watcher running for this project.");
      await gracefulExit();
      return;
    }

    try {
      process.kill(watcher.pid, "SIGTERM");
      unregisterWatcher(watcher.pid);
      console.log(`Stopped watcher (PID: ${watcher.pid})`);
    } catch {
      console.log("Watcher process not found.");
      unregisterWatcher(watcher.pid);
    }
    await gracefulExit();
  });
