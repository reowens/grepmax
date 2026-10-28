import { Command } from "commander";
import { refreshFtsStore } from "../lib/store/fts-refresh";

export const ftsRefresh = new Command("fts-refresh")
  .description(
    "Inspect or explicitly catch up the existing FTS index on an offline store",
  )
  .requiredOption("--table <path>", "Existing chunks.lance directory")
  .option(
    "--check",
    "Check native coverage and bounded input without updating the index",
  )
  .option(
    "--run",
    "Append one fragment-bounded FTS batch under exclusive store ownership",
  )
  .option(
    "--expected-version <number>",
    "Expected current table version",
    Number,
  )
  .option(
    "--acknowledge-uncertain <attempt>",
    "Acknowledge an inspected interrupted attempt",
  )
  .addHelpText(
    "after",
    "\nStatus reads only the durable receipt. --check and --run require closed store owners and --expected-version. Each run processes one batch of whole fragments and reports remainingRows; inspect the new head version before another run. A single fragment exceeding admission is refused. Linux only: at most 100,000 physical input rows, 64 MiB input content, 120 seconds elapsed, 90 seconds CPU, 2 GiB address space and sampled 1 GiB RSS. Sampled disk growth is limited to 512 MiB with 1 GiB additional headroom; it is not a native cumulative-write cap. No service is stopped, containment cleared, data compacted or old version deleted. BM25 scores can change as corpus statistics catch up.",
  )
  .action(async (opts) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const report = await refreshFtsStore({
        ...opts,
        signal: controller.signal,
      });
      console.log(JSON.stringify(report));
    } catch (error) {
      console.error(
        JSON.stringify({
          outcome: "failed",
          error:
            error instanceof Error
              ? error.message
              : "FTS refresh failed; inspect durable state",
        }),
      );
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  });
