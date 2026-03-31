import { spawn } from "node:child_process";
import * as path from "node:path";
import { Command } from "commander";
import { PATHS } from "../config";
import { readGlobalConfig } from "../lib/index/index-config";
import { escapeSqlString } from "../lib/utils/filter-builder";
import { initialSync } from "../lib/index/syncer";
import { startWatcher } from "../lib/index/watcher";
import { MetaCache } from "../lib/store/meta-cache";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { openRotatedLog } from "../lib/utils/log-rotate";
import { killProcess } from "../lib/utils/process";
import { getProject, registerProject } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  getWatcherCoveringPath,
  getWatcherForProject,
  heartbeat,
  isProcessRunning,
  listWatchers,
  migrateFromJson,
  registerWatcher,
  unregisterWatcher,
  updateWatcherStatus,
} from "../lib/utils/watcher-store";

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

    // Check if watcher already running (exact match or parent covering this dir)
    const existing = getWatcherForProject(projectRoot) ?? getWatcherCoveringPath(projectRoot);
    if (existing && isProcessRunning(existing.pid)) {
      console.log(
        `Watcher already running for ${path.basename(existing.projectRoot)} (PID: ${existing.pid})`,
      );
      return;
    }

    // Background spawn
    if (options.background) {
      const args = process.argv
        .slice(2)
        .filter((arg) => arg !== "-b" && arg !== "--background");

      const safeName = projectName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const logFile = path.join(PATHS.logsDir, `watch-${safeName}.log`);
      const out = openRotatedLog(logFile);

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

    // Migrate legacy watchers.json to LMDB on first use
    migrateFromJson();

    // Watcher requires project to be registered
    if (!getProject(projectRoot)) {
      console.error(
        `[watch:${projectName}] Project not registered. Run: gmax add ${projectRoot}`,
      );
      process.exitCode = 1;
      return;
    }

    const paths = ensureProjectPaths(projectRoot);

    // Propagate project root to worker processes
    process.env.GMAX_PROJECT_ROOT = paths.root;

    console.log(`[watch:${projectName}] Starting...`);

    // Register early so MCP can see status
    registerWatcher({
      pid: process.pid,
      projectRoot,
      startTime: Date.now(),
      status: "syncing",
    });

    // Initial sync if this directory isn't indexed yet
    const vectorDb = new VectorDB(paths.lancedbDir);
    const table = await vectorDb.ensureTable();
    const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
    const indexed = await table
      .query()
      .select(["id"])
      .where(`path LIKE '${escapeSqlString(prefix)}%'`)
      .limit(1)
      .toArray();

    if (indexed.length === 0) {
      console.log(
        `[watch:${projectName}] No index found for ${projectRoot}, running initial sync...`,
      );
      const syncResult = await initialSync({ projectRoot });

      // Update registry after sync
      const globalConfig = readGlobalConfig();
      registerProject({
        root: projectRoot,
        name: projectName,
        vectorDim: globalConfig.vectorDim,
        modelTier: globalConfig.modelTier,
        embedMode: globalConfig.embedMode,
        lastIndexed: new Date().toISOString(),
        chunkCount: syncResult.indexed,
        status: "indexed",
      });

      console.log(`[watch:${projectName}] Initial sync complete.`);
    }

    updateWatcherStatus(process.pid, "watching");

    // Open resources for watcher
    const metaCache = new MetaCache(paths.lmdbPath);

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
        updateWatcherStatus(process.pid, "watching", Date.now());
      },
    });

    console.log(`[watch:${projectName}] File watcher active`);

    // Heartbeat — update LMDB every 60s so other processes can detect liveliness
    const heartbeatInterval = setInterval(() => {
      heartbeat(process.pid);
    }, IDLE_CHECK_INTERVAL_MS);

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
      clearInterval(heartbeatInterval);
      try {
        await watcher.close();
      } catch {}
      await metaCache.close();
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
        const killed = await killProcess(w.pid);
        unregisterWatcher(w.pid);
        if (!killed) {
          console.warn(`Warning: PID ${w.pid} did not exit after SIGKILL`);
        }
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

    const killed = await killProcess(watcher.pid);
    unregisterWatcher(watcher.pid);
    if (killed) {
      console.log(`Stopped watcher (PID: ${watcher.pid})`);
    } else {
      console.warn(`Warning: watcher PID ${watcher.pid} did not exit`);
    }
    await gracefulExit();
  });
