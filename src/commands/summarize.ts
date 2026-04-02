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

    const rootPrefix = options.path
      ? `${path.resolve(options.path)}/`
      : "";

    const { spinner } = createIndexingSpinner("", "Summarizing...");

    const { isDaemonRunning, sendStreamingCommand } = await import("../lib/utils/daemon-client");

    if (await isDaemonRunning()) {
      // Daemon mode: IPC streaming
      try {
        const done = await sendStreamingCommand(
          { cmd: "summarize", root: paths.root, pathPrefix: rootPrefix || undefined },
          (msg) => {
            spinner.text = `Summarizing... (${msg.summarized ?? 0}/${msg.total ?? 0})`;
          },
        );

        if (!done.ok) {
          throw new Error((done.error as string) ?? "daemon summarize failed");
        }

        const summarized = (done.summarized as number) ?? 0;
        const remaining = (done.remaining as number) ?? 0;

        if (summarized > 0) {
          const remainMsg = remaining > 0 ? ` (${remaining}+ remaining — run again)` : "";
          spinner.succeed(`Summarized ${summarized} chunks${remainMsg}`);
        } else {
          spinner.succeed("All chunks already have summaries (or summarizer unavailable)");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spinner.fail(`Summarization failed: ${msg}`);
        process.exitCode = 1;
      } finally {
        await gracefulExit();
      }
    } else {
      // Fallback: direct mode
      const vectorDb = new VectorDB(paths.lancedbDir);

      try {
        const { summarized, remaining } = await generateSummaries(
          vectorDb,
          rootPrefix,
          (done, total) => {
            spinner.text = `Summarizing... (${done}/${total})`;
          },
        );

        if (summarized > 0) {
          const remainMsg = remaining > 0 ? ` (${remaining}+ remaining — run again)` : "";
          spinner.succeed(`Summarized ${summarized} chunks${remainMsg}`);
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
    }
  });
