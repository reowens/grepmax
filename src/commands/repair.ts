import * as readline from "node:readline";
import { Command } from "commander";
import ora from "ora";
import { PATHS, REBUILD_COMMAND } from "../config";
import { readGlobalConfig } from "../lib/index/index-config";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { listProjects } from "../lib/utils/project-registry";

function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

export const repair = new Command("repair")
  .description("Repair the centralized index (recover from a schema mismatch)")
  .option(
    "--rebuild",
    "Drop the shared vector table and re-index every project at the configured embedding dim",
    false,
  )
  .option("-y, --yes", "Skip the confirmation prompt", false)
  .addHelpText(
    "after",
    `
The shared LanceDB \`chunks\` table is fixed-width at creation. Switching model
tiers (e.g. small 384d -> standard 768d) strands the table at the old width, so
every write then fails. A per-project \`gmax index --reset\` only deletes rows —
it can't change the table width. \`${REBUILD_COMMAND}\` drops the table and
re-embeds all projects at the current dim.

Examples:
  gmax repair             Show schema status and what a rebuild would do
  gmax repair --rebuild   Drop the table and re-index every project
  gmax repair --rebuild -y  Rebuild without the confirmation prompt
`,
  )
  .action(async (opts: { rebuild: boolean; yes: boolean }) => {
    try {
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
            `\nRun '${REBUILD_COMMAND}' to drop the table and re-index ` +
              `${projects.length} project(s) at ${configDim}d.`,
          );
        } else {
          console.log(
            `\nNothing to repair. Pass --rebuild to force a full drop + re-index anyway.`,
          );
        }
        return;
      }

      if (projects.length === 0) {
        console.log("\nNo indexed projects to rebuild.");
        return;
      }

      const totalChunks = projects.reduce(
        (sum, p) => sum + (p.chunkCount ?? 0),
        0,
      );
      console.log(
        `\nThis will DROP the shared vector table and re-embed ${projects.length} project(s)` +
          (totalChunks > 0
            ? ` (~${totalChunks.toLocaleString()} chunks).`
            : "."),
      );
      for (const p of projects) {
        console.log(`  - ${p.name}`);
      }

      if (!opts.yes) {
        const ok = await confirm("\nContinue?");
        if (!ok) {
          console.log("Cancelled.");
          return;
        }
      }

      // The rebuild must run through the daemon — it is the single writer for
      // the shared table. Refuse rather than risk a torn drop alongside a
      // daemon mid-flush.
      const { ensureDaemonRunning, sendStreamingCommand } = await import(
        "../lib/utils/daemon-client"
      );
      if (!(await ensureDaemonRunning())) {
        console.error(
          "Could not start the gmax daemon. Start it with 'gmax watch --daemon -b' and retry.",
        );
        process.exitCode = 1;
        return;
      }

      const spinner = ora({
        text: "Dropping vector table...",
        isSilent: !process.stdout.isTTY,
      }).start();

      try {
        const done = await sendStreamingCommand({ cmd: "repair" }, (msg) => {
          if (msg.phase === "drop") {
            spinner.text = "Dropping vector table...";
          } else if (msg.phase === "reindex") {
            const doneN = (msg.projectsDone as number) ?? 0;
            const totalN = (msg.projectsTotal as number) ?? projects.length;
            const processed = (msg.processed as number) ?? 0;
            const total = (msg.total as number) ?? 0;
            const counts = total > 0 ? ` ${processed}/${total}` : "";
            spinner.text = `Re-indexing ${msg.project} (${doneN + 1}/${totalN})${counts}`;
          }
        });

        if (!done.ok) {
          spinner.fail("Rebuild failed");
          throw new Error((done.error as string) ?? "daemon repair failed");
        }

        const rebuilt = (done.projects as number) ?? 0;
        const indexed = (done.indexed as number) ?? 0;
        spinner.succeed(
          `Rebuilt ${rebuilt} project(s) at ${configDim}d • ${indexed.toLocaleString()} chunks`,
        );
      } catch (e) {
        if (spinner.isSpinning) spinner.fail("Rebuild failed");
        throw e;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to repair:", message);
      process.exitCode = 1;
    } finally {
      await gracefulExit();
    }
  });
