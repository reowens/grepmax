import { Command } from "commander";
import { PATHS, REBUILD_COMMAND } from "../config";
import { readGlobalConfig } from "../lib/index/index-config";
import { VectorDB } from "../lib/store/vector-db";
import {
  ensureDaemonRunning,
  sendDaemonCommand,
  sendStreamingCommand,
} from "../lib/utils/daemon-client";
import { gracefulExit } from "../lib/utils/exit";
import { listProjects } from "../lib/utils/project-registry";

const REBUILD_PROTOCOL = 1;

export const repair = new Command("repair")
  .description("Repair the centralized index (recover from a schema mismatch)")
  .option(
    "--rebuild",
    "Run the guarded exclusive whole-corpus generation rebuild",
    false,
  )
  .addHelpText(
    "after",
    `
The shared LanceDB \`chunks\` table is fixed-width at creation. Switching model
tiers (e.g. small 384d -> standard 768d) strands the table at the old width, so
every write then fails. A per-project \`gmax index --reset\` only deletes rows —
it can't change the table width. The guarded rebuild runs only through a daemon
that advertises the exclusive-generation protocol; it never falls back to local
store access.

Examples:
  gmax repair             Show schema status
  gmax repair --rebuild   Rebuild every registered project at configured width
`,
  )
  .action(async (opts: { rebuild: boolean }) => {
    try {
      if (opts.rebuild) {
        const running = await ensureDaemonRunning();
        if (!running) throw new Error("failed to start the gmax daemon");
        const ping = await sendDaemonCommand(
          { cmd: "ping" },
          { timeoutMs: 10_000 },
        );
        const capabilities =
          ping.capabilities && typeof ping.capabilities === "object"
            ? (ping.capabilities as Record<string, unknown>)
            : null;
        if (
          !ping.ok ||
          capabilities?.exclusiveGenerationRebuild !== REBUILD_PROTOCOL
        ) {
          throw new Error(
            "running daemon does not support guarded rebuild protocol v1; restart the gmax daemon and retry",
          );
        }

        const done = await sendStreamingCommand(
          { cmd: "repair-v2", protocol: REBUILD_PROTOCOL },
          (progress) => {
            const phase = String(progress.phase ?? "rebuild");
            const project =
              typeof progress.project === "string"
                ? ` ${progress.project}`
                : "";
            const counts =
              typeof progress.processed === "number" &&
              typeof progress.total === "number"
                ? ` ${progress.processed}/${progress.total}`
                : "";
            const message =
              typeof progress.message === "string"
                ? `: ${progress.message}`
                : "";
            console.log(`[${phase}]${project}${counts}${message}`);
          },
          { timeoutMs: 24 * 60 * 60 * 1000 },
        );
        if (!done.ok) {
          const blockers = Array.isArray(done.blockers)
            ? ` Blockers: ${done.blockers
                .map((owner) => {
                  const value = owner as Record<string, unknown>;
                  return `${value.role ?? "unknown"} pid=${value.pid ?? "?"}`;
                })
                .join(", ")}.`
            : "";
          throw new Error(
            `${String(done.error ?? "rebuild failed")}.${blockers}`,
          );
        }
        console.log(
          `Rebuild complete: ${String(done.completed ?? 0)}/${String(done.total ?? 0)} projects indexed.`,
        );
        if (typeof done.warning === "string") console.warn(done.warning);
        return;
      }
      const globalConfig = readGlobalConfig();
      const configDim = globalConfig.vectorDim;

      // Physical width of the on-disk table (null if no table yet). Opened
      // read-only; safe to inspect even while the daemon holds the table.
      let physicalDim: number | null = null;
      const probe = new VectorDB(PATHS.lancedbDir);
      try {
        physicalDim = await probe.getSchemaVectorDim();
      } finally {
        await probe.close();
      }

      const projects = listProjects().filter(
        (p) => p.status === "indexed" || p.status === "pending",
      );

      const dimLine =
        physicalDim == null
          ? "Vector table: none yet"
          : physicalDim === configDim
            ? `Vector table: ${physicalDim}d (matches config)`
            : `Vector table: ${physicalDim}d, config expects ${configDim}d (MISMATCH)`;
      console.log(dimLine);

      if (!opts.rebuild) {
        if (physicalDim != null && physicalDim !== configDim) {
          console.log(
            `\nRun ${REBUILD_COMMAND} to rebuild ${projects.length} project(s) at ${configDim}d.`,
          );
        } else {
          console.log("\nNo schema mismatch detected.");
        }
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to repair:", message);
      process.exitCode = 1;
    } finally {
      await gracefulExit();
    }
  });
