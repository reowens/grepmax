import { Command } from "commander";
import {
  compactStore,
  DEFAULT_FRAGMENT_TARGET_BYTES,
} from "../lib/store/compact";

export const compact = new Command("compact")
  .description(
    "Compact an offline store once: drop deleted rows, merge small fragments and rebuild its indexes",
  )
  .argument("<store>", "Store directory that holds chunks.lance")
  .option("--once", "Run one supervised compaction (required)")
  .option(
    "--target-mib <number>",
    "In-memory size of each output fragment",
    Number,
    DEFAULT_FRAGMENT_TARGET_BYTES / 1024 / 1024,
  )
  .addHelpText(
    "after",
    "\nRun it on a copy of the store, never on a store a daemon serves: it refuses a store whose lease another process holds, and a disk without the table's size plus the disk floor free. The live rows are rewritten into fragments of at most 8,192 rows and 32 MiB, content_idx and path_idx are rebuilt over every row, and every row is compared with the source version before it reports. A failed check restores the source version as head. Old versions stay for the daemon's version cleanup. Automatic maintenance never runs this.",
  )
  .action(
    async (store: string, opts: { once?: boolean; targetMib: number }) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        const report = await compactStore({
          store,
          once: opts.once,
          targetBytes: opts.targetMib * 1024 * 1024,
          signal: controller.signal,
        });
        console.log(JSON.stringify(report));
      } catch (error) {
        console.error(
          JSON.stringify({
            outcome: "failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        process.exitCode = 1;
      } finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
      }
    },
  );
