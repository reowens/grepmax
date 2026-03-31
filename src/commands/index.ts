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

      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      if (options.reset) {
        console.log(`Resetting index at ${paths.dataDir}...`);
        // We do NOT manually drop/rm here anymore to avoid race conditions.
        // The syncer handles it inside the lock.
      }

      // Ensure grammars are present before indexing (silent if already exist)
      await ensureGrammars(console.log, { silent: true });

      // Stop any watcher that covers this project — it holds the shared lock
      const watcher = getWatcherCoveringPath(projectRoot);
      let restartWatcher: { pid: number; projectRoot: string } | null = null;
      if (watcher) {
        console.log(
          `Stopping watcher (PID: ${watcher.pid}) for ${path.basename(watcher.projectRoot)}...`,
        );
        try {
          process.kill(watcher.pid, "SIGTERM");
        } catch {}
        // Wait for process to exit (up to 5s)
        for (let i = 0; i < 50; i++) {
          if (!isProcessRunning(watcher.pid)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        unregisterWatcher(watcher.pid);
        restartWatcher = {
          pid: watcher.pid,
          projectRoot: watcher.projectRoot,
        };
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

        // Update registry with new stats
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
        // Restart the watcher if we stopped one
        if (restartWatcher) {
          const launched = launchWatcher(restartWatcher.projectRoot);
          if (launched) {
            console.log(
              `Restarted watcher for ${path.basename(restartWatcher.projectRoot)} (PID: ${launched.pid})`,
            );
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
