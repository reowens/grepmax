import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { ensureSetup } from "../lib/setup/setup-helpers";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import { gracefulExit } from "../lib/utils/exit";
import { ensureGrammars } from "../lib/index/grammar-loader";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { VectorDB } from "../lib/store/vector-db";

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
  .action(async (_args, cmd) => {
    const options: { store?: string; dryRun: boolean; path: string; reset: boolean } =
      cmd.optsWithGlobals();

    try {
      await ensureSetup();
      const indexRoot = options.path
        ? path.resolve(options.path)
        : process.cwd();
      const projectRoot = findProjectRoot(indexRoot) ?? indexRoot;
      const paths = ensureProjectPaths(projectRoot);
      const vectorDb = new VectorDB(paths.lancedbDir);

      if (options.reset) {
        console.log(`Resetting index at ${paths.osgrepDir}`);
        await vectorDb.drop();
        try {
          fs.rmSync(paths.lmdbPath, { force: true });
        } catch { }
        console.log("Existing index removed. Re-indexing...");
      }

      // Ensure grammars are present before indexing (silent if already exist)
      await ensureGrammars(console.log, { silent: true });

      const { spinner, onProgress } = createIndexingSpinner(
        projectRoot,
        "Indexing...",
      );
      try {
        const result = await initialSync({
          projectRoot,
          dryRun: options.dryRun,
          onProgress,
        });

        if (options.dryRun) {
          spinner.succeed(
            `Dry run complete (${result.processed}/${result.total}) • would have indexed ${result.indexed}`,
          );
          console.log(
            formatDryRunSummary(result, {
              actionDescription: "would have indexed",
              includeTotal: true,
            }),
          );
          await gracefulExit();
          return;
        }

        await vectorDb.createFTSIndex();

        spinner.succeed(
          `Indexing complete (${result.processed}/${result.total}) • indexed ${result.indexed}`,
        );
      } catch (e) {
        spinner.fail("Indexing failed");
        throw e;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to index:", message);
      process.exitCode = 1;
      await gracefulExit(1);
    }
    await gracefulExit();
  });
