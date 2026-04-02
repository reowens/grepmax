import * as path from "node:path";
import { Command } from "commander";
import { readGlobalConfig } from "../lib/index/index-config";
import { ensureGrammars } from "../lib/index/grammar-loader";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { getProject, registerProject } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { launchWatcher } from "../lib/utils/watcher-launcher";
import {
  getWatcherCoveringPath,
  isProcessRunning,
  unregisterWatcher,
} from "../lib/utils/watcher-store";

export const index = new Command("index")
  .description("Index the current directory and create searchable store")
  .option(
    "-d, --dry-run",
    "Dry run the indexing process (no actual file syncing)",
    false,
  )
  .option(
    "-p, --path <dir>",
    "Path to index (defaults to current directory)",
    "",
  )
  .option(
    "-r, --reset",
    "Remove existing index and re-index from scratch",
    false,
  )
  .option("-v, --verbose", "Show detailed progress with file names", false)
  .addHelpText(
    "after",
    `
Examples:
  gmax index                     Index current directory
  gmax index --path ~/workspace  Index a specific directory
  gmax index --dry-run           Preview what would be indexed
  gmax index --reset             Full re-index from scratch
`,
  )
  .action(async (_args, cmd) => {
    const options: {
      store?: string;
      dryRun: boolean;
      path: string;
      reset: boolean;
      verbose: boolean;
    } = cmd.optsWithGlobals();
    let vectorDb: VectorDB | null = null;
    const ac = new AbortController();
    let aborted = false;
    const onSignal = () => {
      if (aborted) return;
      aborted = true;
      ac.abort();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    try {
      await ensureSetup();
      const indexRoot = options.path
        ? path.resolve(options.path)
        : process.cwd();
      const projectRoot = findProjectRoot(indexRoot) ?? indexRoot;

      // Project must be registered before reindexing
      if (!getProject(projectRoot)) {
        console.error(
          `This project hasn't been added yet.\n\nRun: gmax add ${projectRoot}\n`,
        );
        process.exitCode = 1;
        return;
      }

      if (options.reset) {
        console.log("Resetting index...");
      }

      // Ensure grammars are present before indexing (silent if already exist)
      await ensureGrammars(console.log, { silent: true });

      const { isDaemonRunning, sendStreamingCommand } = await import("../lib/utils/daemon-client");

      if (await isDaemonRunning()) {
        // Daemon mode: IPC streaming — daemon handles watcher pause/resume internally
        const { spinner, onProgress } = createIndexingSpinner(
          projectRoot,
          "Indexing...",
          { verbose: options.verbose },
        );

        try {
          const done = await sendStreamingCommand(
            { cmd: "index", root: projectRoot, reset: options.reset, dryRun: options.dryRun },
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
            throw new Error((done.error as string) ?? "daemon index failed");
          }

          if (options.dryRun) {
            spinner.succeed(
              `Dry run complete(${done.processed} / ${done.total}) • would have indexed ${done.indexed} `,
            );
            return;
          }

          const globalConfig = readGlobalConfig();
          registerProject({
            root: projectRoot,
            name: path.basename(projectRoot),
            vectorDim: globalConfig.vectorDim,
            modelTier: globalConfig.modelTier,
            embedMode: globalConfig.embedMode,
            lastIndexed: new Date().toISOString(),
            chunkCount: (done.indexed as number) ?? 0,
            status: "indexed",
          });

          const failedFiles = (done.failedFiles as number) ?? 0;
          const failedSuffix = failedFiles > 0 ? ` • ${failedFiles} failed` : "";
          spinner.succeed(
            `Indexing complete(${done.processed} / ${done.total}) • indexed ${done.indexed}${failedSuffix} `,
          );
        } catch (e) {
          spinner.fail("Indexing failed");
          throw e;
        }
      } else {
        // Fallback: direct mode with lock — stop any watcher first
        const paths = ensureProjectPaths(projectRoot);
        vectorDb = new VectorDB(paths.lancedbDir);

        let restartWatcher = false;
        const watcher = getWatcherCoveringPath(projectRoot);
        if (watcher) {
          console.log(
            `Stopping watcher (PID: ${watcher.pid}) for ${path.basename(watcher.projectRoot)}...`,
          );
          try {
            process.kill(watcher.pid, "SIGTERM");
          } catch {}
          for (let i = 0; i < 50; i++) {
            if (!isProcessRunning(watcher.pid)) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          unregisterWatcher(watcher.pid);
          restartWatcher = true;
        }

        const { spinner, onProgress } = createIndexingSpinner(
          projectRoot,
          "Indexing...",
          { verbose: options.verbose },
        );
        try {
          const result = await initialSync({
            projectRoot,
            dryRun: options.dryRun,
            reset: options.reset,
            onProgress,
            signal: ac.signal,
          });

          if (aborted) {
            spinner.warn(
              `Indexing interrupted — partial progress saved (${result.indexed} indexed)`,
            );
            return;
          }

          if (options.dryRun) {
            spinner.succeed(
              `Dry run complete(${result.processed} / ${result.total}) • would have indexed ${result.indexed} `,
            );
            console.log(
              formatDryRunSummary(result, {
                actionDescription: "would have indexed",
                includeTotal: true,
              }),
            );
            return;
          }

          const globalConfig = readGlobalConfig();
          registerProject({
            root: projectRoot,
            name: path.basename(projectRoot),
            vectorDim: globalConfig.vectorDim,
            modelTier: globalConfig.modelTier,
            embedMode: globalConfig.embedMode,
            lastIndexed: new Date().toISOString(),
            chunkCount: result.indexed,
            status: "indexed",
          });

          const failedSuffix =
            result.failedFiles > 0 ? ` • ${result.failedFiles} failed` : "";
          spinner.succeed(
            `Indexing complete(${result.processed} / ${result.total}) • indexed ${result.indexed}${failedSuffix} `,
          );
        } catch (e) {
          spinner.fail("Indexing failed");
          throw e;
        } finally {
          if (restartWatcher) {
            const launched = await launchWatcher(projectRoot);
            if (launched.ok) {
              console.log(
                `Restarted watcher for ${path.basename(projectRoot)} (PID: ${launched.pid})`,
              );
            } else if (launched.reason === "spawn-failed") {
              console.warn(`[index] ${launched.message}`);
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to index:", message);
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch (err) {
          console.error("Failed to close VectorDB:", err);
        }
      }
      const code =
        typeof process.exitCode === "number"
          ? process.exitCode
          : process.exitCode === undefined
            ? 0
            : 1;
      await gracefulExit(code);
    }
  });
