import * as path from "node:path";
import { Command } from "commander";
import {
  type ProjectOverview,
  runProject,
  withLocalStore,
} from "../lib/daemon/rows-handler";
import { sendDaemonCommand } from "../lib/utils/daemon-client";
import { gracefulExit } from "../lib/utils/exit";
import { listProjects, resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  reportStoreAccessRefusal,
  withStoreRead,
} from "../lib/utils/store-access";

export const project = new Command("project")
  .description("Show project overview — languages, structure, key symbols")
  .option("--root <dir>", "Project root (defaults to current directory)")
  .option("--agent", "Compact output for AI agents", false)
  .action(async (opts) => {
    try {
      const resolvedRoot = resolveRootOrExit(opts.root);
      if (resolvedRoot === null) return;
      const root = findProjectRoot(resolvedRoot) ?? resolvedRoot;
      const projectName = path.basename(root);
      const paths = ensureProjectPaths(root);

      // The scan behind this overview reaches 200 000 rows with two symbol
      // array columns; the daemon aggregates and ships the summary, never the
      // rows (the platform project alone holds 266 753 chunks).
      const overview = await withStoreRead<ProjectOverview>("project", {
        daemon: () =>
          sendDaemonCommand(
            { cmd: "rows.project", projectRoot: root },
            { timeoutMs: 120_000 },
          ),
        render: (resp) => resp.overview as ProjectOverview,
        inProcess: () =>
          withLocalStore(paths.lancedbDir, (deps) => runProject(deps, root)),
        fallbackOnUnknownVerb: true,
      });

      if (overview.chunks === 0) {
        console.log(
          `No indexed data found for ${root}. Run: gmax index --path ${root}`,
        );
        process.exitCode = 1;
        return;
      }

      const projects = listProjects();
      const proj = projects.find((p) => p.root === root);
      const {
        chunks,
        files,
        extEntries,
        dirEntries,
        roleEntries,
        topSymbols,
        entryPoints,
      } = overview;

      if (opts.agent) {
        console.log(`name\t${projectName}`);
        console.log(`root\t${root}`);
        console.log(`chunks\t${chunks}`);
        console.log(`files\t${files}`);
        console.log(`last_indexed\t${proj?.lastIndexed ?? "unknown"}`);
        console.log(`languages\t${extEntries.map(([ext]) => ext).join(",")}`);
        console.log(
          `top_dirs\t${dirEntries
            .slice(0, 8)
            .map(([d]) => d)
            .join(",")}`,
        );
        if (topSymbols.length > 0) {
          console.log(`key_symbols\t${topSymbols.map(([s]) => s).join(",")}`);
        }
        if (entryPoints.length > 0) {
          console.log(
            `entry_points\t${entryPoints.map((e) => e.symbol).join(",")}`,
          );
        }
      } else {
        console.log(`Project: ${projectName} (${root})`);
        console.log(
          `Last indexed: ${proj?.lastIndexed ?? "unknown"} • ${chunks} chunks • ${files} files\n`,
        );

        console.log(
          `Languages: ${extEntries.map(([ext, count]) => `${ext} (${Math.round((count / chunks) * 100)}%)`).join(", ")}\n`,
        );

        console.log("Directory structure:");
        for (const [dir, data] of dirEntries) {
          console.log(
            `  ${dir.padEnd(25)} (${data.files} files, ${data.chunks} chunks)`,
          );
        }

        console.log(
          `\nRoles: ${roleEntries.map(([r, c]) => `${Math.round((c / chunks) * 100)}% ${r}`).join(", ")}\n`,
        );

        if (topSymbols.length > 0) {
          console.log("Key symbols (by reference count):");
          for (const [sym, count] of topSymbols) {
            console.log(`  ${sym.padEnd(25)} (referenced ${count}x)`);
          }
        }

        if (entryPoints.length > 0) {
          console.log("\nEntry points (exported orchestration):");
          for (const ep of entryPoints) {
            console.log(`  ${ep.symbol.padEnd(25)} ${ep.path}`);
          }
        }
      }
    } catch (error) {
      if (!reportStoreAccessRefusal(error)) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("Project summary failed:", msg);
        process.exitCode = 1;
      }
    } finally {
      await gracefulExit();
    }
  });
