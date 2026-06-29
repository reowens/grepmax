import { Command } from "commander";
import { findTests, resolveTargetSymbols } from "../lib/graph/impact";
import {
  formatViaAgent,
  formatViaHuman,
  groupTestHitsByFile,
  hopLabelAgent,
  hopLabelHuman,
} from "../lib/graph/test-hits";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";

export const testFind = new Command("test")
  .description("Find tests that exercise a symbol or file")
  .argument("<target>", "Symbol name or file path")
  .option("-d, --depth <n>", "Caller traversal depth (default 1, max 3)", "1")
  .option("--root <dir>", "Project root directory")
  .option(
    "--in <subpath>",
    "Restrict to a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option(
    "--exclude <subpath>",
    "Exclude a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option("--agent", "Compact output for AI agents", false)
  .action(async (target, opts) => {
    const depth = Math.min(
      Math.max(Number.parseInt(opts.depth || "1", 10), 1),
      3,
    );
    let vectorDb: VectorDB | null = null;

    try {
      const root = resolveRootOrExit(opts.root);
      if (root === null) return;
      const projectRoot = findProjectRoot(root) ?? root;
      maybeWarnStaleChunker(projectRoot, { agent: opts.agent });
      maybeWarnStaleEmbedding(projectRoot, { agent: opts.agent });
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      const { symbols, resolvedAsFile, symbolFamilies } =
        await resolveTargetSymbols(target, vectorDb, projectRoot);

      if (symbols.length === 0) {
        console.log(
          resolvedAsFile
            ? `No symbols found in file: ${target}`
            : `Symbol not found: ${target}`,
        );
        process.exitCode = 1;
        return;
      }

      const { resolveScope } = await import("../lib/utils/scope-filter");
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });
      const queryRoot =
        opts.in && opts.in.length > 0
          ? scope.pathPrefix.replace(/\/$/, "")
          : projectRoot;
      const tests = await findTests(
        symbols,
        vectorDb,
        queryRoot,
        depth,
        scope.excludePrefixes,
        symbolFamilies,
      );

      if (tests.length === 0) {
        console.log(`No tests found for ${target}.`);
        return;
      }

      const rel = (p: string) =>
        p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;

      // One line per test file: the file is what the reader runs; caller
      // symbols inside it (often internal helpers) are detail, not the lead.
      const grouped = groupTestHitsByFile(tests);
      if (opts.agent) {
        for (const t of grouped) {
          console.log(
            `${rel(t.file)}:${t.line + 1}\t${hopLabelAgent(t.hops)}${formatViaAgent(t.via)}`,
          );
        }
      } else {
        console.log(`Tests for ${target}:\n`);
        for (const t of grouped) {
          console.log(
            `  ${rel(t.file)}:${t.line + 1}  (${hopLabelHuman(t.hops)}${formatViaHuman(t.via)})`,
          );
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Test find failed:", msg);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch {}
      }
      await gracefulExit();
    }
  });
