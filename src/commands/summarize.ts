import * as path from "node:path";
import { Command } from "commander";
import { createIndexingSpinner } from "../lib/index/sync-helpers";
import { generateSummaries } from "../lib/index/syncer";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths } from "../lib/utils/project-root";

export const summarize = new Command("summarize")
  .description(
    "Generate LLM summaries for indexed chunks without re-indexing",
  )
  .option(
    "-p, --path <dir>",
    "Only summarize chunks under this directory",
  )
  .action(async (options: { path?: string }) => {
    const paths = ensureProjectPaths(process.cwd());
    const vectorDb = new VectorDB(paths.lancedbDir);

    const rootPrefix = options.path
      ? `${path.resolve(options.path)}/`
      : "";

    const { spinner } = createIndexingSpinner("", "Summarizing...");

    try {
      const count = await generateSummaries(
        vectorDb,
        rootPrefix,
        (done, total) => {
          spinner.text = `Summarizing... (${done}/${total})`;
        },
      );

      if (count > 0) {
        spinner.succeed(`Summarized ${count} chunks`);
      } else {
        spinner.succeed("All chunks already have summaries (or summarizer unavailable)");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      spinner.fail(`Summarization failed: ${msg}`);
      process.exitCode = 1;
    } finally {
      await vectorDb.close();
      await gracefulExit();
    }
  });
