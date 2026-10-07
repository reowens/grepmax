import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { readPruneState } from "../lib/store/prune-state";
import { recoverStore } from "../lib/store/recovery";

export function parseRecoveryCutoff(value: string): Date {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match)
    throw new Error(
      "--cutoff requires an absolute ISO timestamp with timezone",
    );
  const calendar = new Date(`${value.slice(0, 19)}Z`);
  const parts = [
    calendar.getUTCFullYear(),
    calendar.getUTCMonth() + 1,
    calendar.getUTCDate(),
    calendar.getUTCHours(),
    calendar.getUTCMinutes(),
    calendar.getUTCSeconds(),
  ];
  const result = new Date(value);
  if (
    parts.some((part, i) => part !== Number(match[i + 1])) ||
    !Number.isFinite(result.getTime())
  )
    throw new Error("--cutoff is not a valid calendar timestamp");
  return result;
}

export const recover = new Command("recover")
  .description(
    "Inspect or explicitly prune an offline Lance store without rewriting it",
  )
  .requiredOption("--table <path>", "Existing .lance table directory")
  .option("--check", "Check recovery admission without preparing or pruning")
  .option(
    "--prune",
    "Explicitly perform exclusively leased prune-only recovery",
  )
  .option("--version <number>", "Expected current table version", Number)
  .option("--cutoff <timestamp>", "Real absolute ISO retention cutoff")
  .option(
    "--acknowledge-uncertain <attempt>",
    "Acknowledge an inspected uncertain attempt before explicit retry",
  )
  .option("--json", "Structured outcome and durable receipt")
  .addHelpText(
    "after",
    "\nStatus is metadata-only. Pruning requires a persistent autostart-disabled file in the store home, closed store owners, known healthy macOS resources, --version and --cutoff. Recovery does not stop services or clear containment. --check can refuse under unknown pressure without pausing normal service.",
  )
  .action(async (opts) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const report = await recoverStore({
        table: opts.table,
        check: opts.check,
        prune: opts.prune,
        version: opts.version,
        cutoff: opts.cutoff ? parseRecoveryCutoff(opts.cutoff) : undefined,
        acknowledgeUncertain: opts.acknowledgeUncertain,
        signal: controller.signal,
      });
      console.log(JSON.stringify(report, null, opts.json ? undefined : 2));
    } catch (error) {
      let state: ReturnType<typeof readPruneState> | "unverified" =
        "unverified";
      try {
        state = readPruneState(path.dirname(fs.realpathSync(opts.table)));
      } catch {}
      console.error(
        JSON.stringify({
          outcome:
            state === "unverified" || state?.outcome === "uncertain"
              ? "uncertain"
              : "refused",
          error: error instanceof Error ? error.message : "Recovery failed",
          state,
        }),
      );
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  });
