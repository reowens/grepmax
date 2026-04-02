import * as path from "node:path";
import * as readline from "node:readline";
import { Command } from "commander";
import { MetaCache } from "../lib/store/meta-cache";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { killProcess } from "../lib/utils/process";
import { removeMarker } from "../lib/utils/project-marker";
import {
  getProject,
  removeProject,
} from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  getWatcherForProject,
  unregisterWatcher,
} from "../lib/utils/watcher-store";

function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

export const remove = new Command("remove")
  .description("Remove a project from the gmax index")
  .argument("[dir]", "Directory to remove (defaults to current directory)")
  .option("-f, --force", "Skip confirmation prompt", false)
  .addHelpText(
    "after",
    `
Examples:
  gmax remove                  Remove the current project
  gmax remove ~/projects/app   Remove a specific project
  gmax remove --force          Skip confirmation
`,
  )
  .action(async (dir, opts) => {
    let vectorDb: VectorDB | null = null;
    let metaCache: MetaCache | null = null;

    try {
      const targetDir = dir ? path.resolve(dir) : process.cwd();
      const projectRoot = findProjectRoot(targetDir) ?? targetDir;
      const projectName = path.basename(projectRoot);
      const project = getProject(projectRoot);

      if (!project) {
        console.log(`${projectName} is not in the gmax index.`);
        return;
      }

      const chunkStr = project.chunkCount
        ? ` (${project.chunkCount.toLocaleString()} chunks)`
        : "";

      if (!opts.force) {
        const ok = await confirm(
          `Remove ${projectName}${chunkStr} from the index? This deletes all indexed data.`,
        );
        if (!ok) {
          console.log("Cancelled.");
          return;
        }
      }

      const { isDaemonRunning, sendStreamingCommand } = await import("../lib/utils/daemon-client");

      if (await isDaemonRunning()) {
        // Daemon mode: IPC handles unwatch + LanceDB delete + MetaCache cleanup
        const done = await sendStreamingCommand(
          { cmd: "remove", root: projectRoot },
          () => {}, // no progress for remove
        );
        if (!done.ok) {
          throw new Error((done.error as string) ?? "daemon remove failed");
        }
      } else {
        // Fallback: direct mode — stop watcher + delete directly
        const watcher = getWatcherForProject(projectRoot);
        if (watcher) {
          console.log(`Stopping watcher (PID: ${watcher.pid})...`);
          await killProcess(watcher.pid);
          unregisterWatcher(watcher.pid);
        }

        const paths = ensureProjectPaths(projectRoot);
        vectorDb = new VectorDB(paths.lancedbDir);
        await vectorDb.deletePathsWithPrefix(projectRoot);

        metaCache = new MetaCache(paths.lmdbPath);
        const keys = await metaCache.getKeysWithPrefix(projectRoot);
        for (const key of keys) {
          metaCache.delete(key);
        }
      }

      // Registry + marker cleanup in both paths
      removeProject(projectRoot);
      removeMarker(projectRoot);

      console.log(
        `Removed ${projectName}${chunkStr}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to remove project:", message);
      process.exitCode = 1;
    } finally {
      if (metaCache) {
        try {
          metaCache.close();
        } catch {}
      }
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch {}
      }
      await gracefulExit();
    }
  });
