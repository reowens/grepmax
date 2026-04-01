import * as path from "node:path";
import { Command } from "commander";
import { findTests, resolveTargetSymbols } from "../lib/graph/impact";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

export const testFind = new Command("test")
  .description("Find tests that exercise a symbol or file")
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

      const tests = await findTests(symbols, vectorDb, projectRoot, depth);

      if (tests.length === 0) {
        console.log(`No tests found for ${target}.`);
        return;
      }

      const rel = (p: string) =>
        p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;

      if (opts.agent) {
        for (const t of tests) {
          const hopLabel = t.hops === 0 ? "direct" : `${t.hops}-hop`;
          console.log(`${rel(t.file)}:${t.line + 1}\t${t.symbol}\t${hopLabel}`);
        }
      } else {
        console.log(`Tests for ${target}:\n`);
        for (const t of tests) {
          const hopLabel =
            t.hops === 0 ? "calls directly" : `${t.hops} hop${t.hops > 1 ? "s" : ""} away`;
          console.log(`  ${rel(t.file)}:${t.line + 1}  ${t.symbol}  (${hopLabel})`);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Test find failed:", msg);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try { await vectorDb.close(); } catch {}
      }
      await gracefulExit();
    }
  });
