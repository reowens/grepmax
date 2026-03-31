import * as path from "node:path";
import { Command } from "commander";
import {
  findDependents,
  findTests,
  isTestPath,
  resolveTargetSymbols,
} from "../lib/graph/impact";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

export const impact = new Command("impact")
  .description("Analyze change impact: dependents and affected tests")
  .argument("<target>", "Symbol name or file path")
  .option("-d, --depth <n>", "Caller traversal depth (default 1, max 3)", "1")
  .option("--root <dir>", "Project root directory")
  .option("--agent", "Compact output for AI agents", false)
  .action(async (target, opts) => {
    const depth = Math.min(
      Math.max(Number.parseInt(opts.depth || "1", 10), 1),
      3,
    );
    let vectorDb: VectorDB | null = null;

    try {
      const root = opts.root ? path.resolve(opts.root) : process.cwd();
      const projectRoot = findProjectRoot(root) ?? root;
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      const { symbols, resolvedAsFile } = await resolveTargetSymbols(
        target,
        vectorDb,
        projectRoot,
      );

      if (symbols.length === 0) {
        console.log(
          resolvedAsFile
            ? `No symbols found in file: ${target}`
            : `Symbol not found: ${target}`,
        );
        process.exitCode = 1;
        return;
      }

      // Resolve the target's own file path for exclusion
      const targetPath = resolvedAsFile
        ? (target.startsWith("/") ? target : path.resolve(projectRoot, target))
        : undefined;
      const excludePaths = targetPath ? new Set([targetPath]) : undefined;

      // Run dependents and tests in parallel
      const [dependents, tests] = await Promise.all([
        findDependents(symbols, vectorDb, projectRoot, excludePaths),
        findTests(symbols, vectorDb, projectRoot, depth),
      ]);

      // Separate test files from non-test dependents
      const nonTestDeps = dependents.filter((d) => !isTestPath(d.file));

      const rel = (p: string) =>
        p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;

      if (opts.agent) {
        for (const d of nonTestDeps) {
          console.log(`dep: ${rel(d.file)}\t${d.sharedSymbols}`);
        }
        for (const t of tests) {
          const hopLabel = t.hops === 0 ? "direct" : `${t.hops}-hop`;
          console.log(`test: ${rel(t.file)}:${t.line + 1}\t${t.symbol}\t${hopLabel}`);
        }
        if (!nonTestDeps.length && !tests.length) {
          console.log("(no impact detected)");
        }
      } else {
        console.log(`Impact analysis for ${target}:\n`);

        if (nonTestDeps.length > 0) {
          console.log(`Direct dependents (${nonTestDeps.length}):`);
          for (const d of nonTestDeps) {
            console.log(
              `  ${rel(d.file).padEnd(45)} (${d.sharedSymbols} shared symbol${d.sharedSymbols > 1 ? "s" : ""})`,
            );
          }
        } else {
          console.log("Direct dependents: none found");
        }

        console.log("");

        if (tests.length > 0) {
          console.log(`Affected tests (${tests.length}):`);
          for (const t of tests) {
            const hopLabel =
              t.hops === 0 ? "calls directly" : `${t.hops} hop${t.hops > 1 ? "s" : ""} away`;
            console.log(`  ${rel(t.file)}:${t.line + 1}  ${t.symbol}  (${hopLabel})`);
          }
        } else {
          console.log("Affected tests: none found");
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Impact analysis failed:", msg);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try { await vectorDb.close(); } catch {}
      }
      await gracefulExit();
    }
  });
