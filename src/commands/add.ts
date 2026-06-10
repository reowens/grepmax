import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { CONFIG } from "../config";
import { ensureGrammars } from "../lib/index/grammar-loader";
import { readGlobalConfig } from "../lib/index/index-config";
import {
  createIndexingSpinner,
} from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { createMarker } from "../lib/utils/project-marker";
import {
  getChildProjects,
  getParentProject,
  getProject,
  registerProject,
  removeProject,
} from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { launchWatcher } from "../lib/utils/watcher-launcher";

function getBlockedRoots(): Set<string> {
  const home = os.homedir();
  return new Set(
    [
      home,
      path.dirname(home),
      "/",
      "/tmp",
      "/private",
      "/private/tmp",
      "/private/var",
      "/var",
      "/usr",
      "/opt",
      "/etc",
      "/System",
      "/Library",
      "/Applications",
    ].map((p) => path.resolve(p)),
  );
}

function logBlockedAttempt(reason: string, attempted: string, extra?: Record<string, unknown>): void {
  try {
    const logPath = path.join(os.homedir(), ".gmax", "logs", "blocked-add.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      reason,
      attempted,
      cwd: process.cwd(),
      pid: process.pid,
      ppid: process.ppid,
      argv: process.argv,
      env_claude_session: process.env.CLAUDE_SESSION_ID ?? null,
      env_claude_project_dir: process.env.CLAUDE_PROJECT_DIR ?? null,
      ...extra,
    };
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {}
}

export const add = new Command("add")
  .description("Add a project to the gmax index")
  .argument("[dir]", "Directory to add (defaults to current directory)")
  .option("--no-index", "Register the project without indexing it")
  .option(
    "--force",
    "Allow adding a parent of existing projects (will REMOVE absorbed children)",
  )
  .addHelpText(
    "after",
    `
Examples:
  gmax add                     Add the current directory
  gmax add ~/projects/myapp    Add a specific project
  gmax add . --no-index        Register only, index later with gmax index
`,
  )
  .action(async (dir, opts) => {
    let vectorDb: VectorDB | null = null;

    try {
      const targetDir = dir ? path.resolve(dir) : process.cwd();
      const projectRoot = findProjectRoot(targetDir) ?? targetDir;
      const projectName = path.basename(projectRoot);

      const blocked = getBlockedRoots();
      if (blocked.has(path.resolve(projectRoot))) {
        logBlockedAttempt("blocked_root", projectRoot);
        console.error(
          `Refusing to add ${projectRoot}: this path is blocked from indexing.\n` +
            `(Blocked: home, /, /Users, /tmp, /private, /var, /usr, /opt, /etc, /System, /Library, /Applications.)\n` +
            `Pick a specific project subdirectory instead.\n` +
            `Diagnostic logged to ~/.gmax/logs/blocked-add.log (cwd=${process.cwd()} ppid=${process.ppid}).`,
        );
        process.exitCode = 1;
        return;
      }

      // Check if already registered
      const existing = getProject(projectRoot);
      if (existing) {
        console.log(
          `${projectName} is already added (${existing.chunkCount ?? 0} chunks).`,
        );
        console.log(`Run \`gmax index\` to re-index, or \`gmax index --reset\` for a full rebuild.`);
        return;
      }

      // Check if a parent project already covers this path
      const parent = getParentProject(projectRoot);
      if (parent) {
        console.log(
          `Already covered by ${path.basename(parent.root)} (${parent.root}).`,
        );
        console.log(`Use \`gmax status\` to see indexed projects.`);
        return;
      }

      // If this is a parent of existing projects, absorb them
      const children = getChildProjects(projectRoot);
      if (children.length > 0) {
        if (!opts.force) {
          logBlockedAttempt("would_absorb_children", projectRoot, {
            children: children.map((c) => ({ name: c.name, root: c.root })),
          });
          console.error(
            `Refusing to add ${projectRoot}: would absorb ${children.length} existing project(s):\n` +
              `${children.map((c) => `  - ${c.name} (${c.root})`).join("\n")}\n` +
              `Re-run with --force to proceed (this will REMOVE the listed projects and their indexed data).\n` +
              `Diagnostic logged to ~/.gmax/logs/blocked-add.log (cwd=${process.cwd()} ppid=${process.ppid}).`,
          );
          process.exitCode = 1;
          return;
        }

        const names = children.map((c) => c.name).join(", ");
        console.log(
          `Absorbing ${children.length} sub-project(s): ${names}`,
        );

        const { ensureDaemonRunning: checkDaemon, sendStreamingCommand: sendCmd } =
          await import("../lib/utils/daemon-client");
        const daemonUp = await checkDaemon();

        for (const child of children) {
          if (daemonUp) {
            // Daemon handles unwatch + vector delete + MetaCache cleanup
            await sendCmd({ cmd: "remove", root: child.root }, () => {});
          } else {
            // Direct mode: delete vectors and MetaCache entries
            const childPaths = ensureProjectPaths(child.root);
            const db = new VectorDB(childPaths.lancedbDir);
            const childPrefix = child.root.endsWith("/") ? child.root : `${child.root}/`;
            await db.deletePathsWithPrefix(childPrefix);
            const { MetaCache } = await import("../lib/store/meta-cache");
            const mc = new MetaCache(childPaths.lmdbPath);
            const keys = await mc.getKeysWithPrefix(childPrefix);
            for (const key of keys) mc.delete(key);
            mc.close();
            await db.close();
          }
          removeProject(child.root);
        }
      }

      // Create marker file
      createMarker(projectRoot);

      // Register as pending
      const globalConfig = readGlobalConfig();
      registerProject({
        root: projectRoot,
        name: projectName,
        vectorDim: globalConfig.vectorDim,
        modelTier: globalConfig.modelTier,
        embedMode: globalConfig.embedMode,
        lastIndexed: "",
        chunkCount: 0,
        status: "pending",
      });

      if (!opts.index) {
        console.log(`Registered ${projectName}. Run \`gmax index\` when ready to index.`);
        return;
      }

      // Index the project
      await ensureSetup();
      await ensureGrammars(console.log, { silent: true });

      const { spinner, onProgress } = createIndexingSpinner(
        projectRoot,
        `Adding ${projectName}...`,
      );

      const { ensureDaemonRunning, sendStreamingCommand } = await import("../lib/utils/daemon-client");
      const pendingEntry = {
        root: projectRoot,
        name: projectName,
        vectorDim: globalConfig.vectorDim,
        modelTier: globalConfig.modelTier,
        embedMode: globalConfig.embedMode,
        lastIndexed: "",
        chunkCount: 0,
        status: "error" as const,
      };

      if (await ensureDaemonRunning()) {
        // Daemon mode: IPC streaming
        try {
          const done = await sendStreamingCommand(
            { cmd: "add", root: projectRoot },
            (msg) => {
              onProgress({
                processed: (msg.processed as number) ?? 0,
                indexed: (msg.indexed as number) ?? 0,
                total: (msg.total as number) ?? 0,
                filePath: msg.filePath as string,
              });
            },
          );

          if (!done.ok) {
            throw new Error((done.error as string) ?? "daemon add failed");
          }

          registerProject({
            ...pendingEntry,
            lastIndexed: new Date().toISOString(),
            chunkCount: (done.indexed as number) ?? 0,
            status: "indexed",
            chunkerVersion: CONFIG.CHUNKER_VERSION,
          });

          const failedFiles = (done.failedFiles as number) ?? 0;
          const failedSuffix = failedFiles > 0 ? ` · ${failedFiles} failed` : "";
          spinner.succeed(
            `Added ${projectName} (${done.total} files, ${done.indexed} chunks${failedSuffix})`,
          );
          // Watcher already started by daemon's addProject
        } catch (e) {
          registerProject(pendingEntry);
          spinner.fail(`Failed to index ${projectName}`);
          throw e;
        }
      } else {
        // Fallback: direct mode with lock
        const paths = ensureProjectPaths(projectRoot);
        vectorDb = new VectorDB(paths.lancedbDir);

        try {
          const result = await initialSync({
            projectRoot,
            onProgress,
          });

          registerProject({
            ...pendingEntry,
            lastIndexed: new Date().toISOString(),
            chunkCount: result.indexed,
            status: "indexed",
            chunkerVersion: CONFIG.CHUNKER_VERSION,
          });

          const failedSuffix =
            result.failedFiles > 0 ? ` · ${result.failedFiles} failed` : "";
          spinner.succeed(
            `Added ${projectName} (${result.total} files, ${result.indexed} chunks${failedSuffix})`,
          );
        } catch (e) {
          registerProject(pendingEntry);
          spinner.fail(`Failed to index ${projectName}`);
          throw e;
        }

        // Start watcher (only in direct mode — daemon handles it in IPC mode)
        const launched = await launchWatcher(projectRoot);
        if (launched.ok) {
          console.log(`Watcher started (PID: ${launched.pid})`);
        } else if (launched.reason === "spawn-failed") {
          console.warn(`[add] ${launched.message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to add project:", message);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch {}
      }
      await gracefulExit();
    }
  });
