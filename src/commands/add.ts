import * as path from "node:path";
import { Command } from "commander";
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

export const add = new Command("add")
  .description("Add a project to the gmax index")
  .argument("[dir]", "Directory to add (defaults to current directory)")
  .option("--no-index", "Register the project without indexing it")
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
        const names = children.map((c) => c.name).join(", ");
        console.log(
          `Absorbing ${children.length} sub-project(s): ${names}`,
        );
        for (const child of children) {
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

      const { isDaemonRunning, sendStreamingCommand } = await import("../lib/utils/daemon-client");
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

      if (await isDaemonRunning()) {
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
