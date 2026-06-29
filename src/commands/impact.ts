import * as path from "node:path";
import { Command } from "commander";
import {
  findDependents,
  findTests,
  isTestPath,
  resolveTargetSymbols,
} from "../lib/graph/impact";
import {
  formatViaAgent,
  formatViaHuman,
  groupTestHitsByFile,
  hopLabelAgent,
  hopLabelHuman,
} from "../lib/graph/test-hits";
import { VectorDB } from "../lib/store/vector-db";
import { symbolNotFoundLines } from "../lib/utils/agent-errors";
import { gracefulExit } from "../lib/utils/exit";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";

export const impact = new Command("impact")
  .description("Analyze change impact: dependents and affected tests")
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
  .option(
    "--no-tests",
    "Skip affected-test analysis; show production blast radius only",
  )
  .option("--agent", "Compact output for AI agents", false)
  .action(async (target, opts) => {
    const depth = Math.min(
      Math.max(Number.parseInt(opts.depth || "1", 10), 1),
      3,
    );
    // commander maps --no-tests → opts.tests === false (defaults true).
    const includeTests = opts.tests !== false;
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
            : symbolNotFoundLines(target, { agent: opts.agent }).join("\n"),
        );
        process.exitCode = 1;
        return;
      }

      // Resolve the target's own file path for exclusion
      const targetPath = resolvedAsFile
        ? target.startsWith("/")
          ? target
          : path.resolve(projectRoot, target)
        : undefined;
      const excludePaths = targetPath ? new Set([targetPath]) : undefined;

      const { resolveScope } = await import("../lib/utils/scope-filter");
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });
      // Treat --in as an exclude-everything-else when set: any prefix that
      // isn't the --in scope becomes effectively excluded. Today findDependents
      // always queries within projectRoot; passing scope.pathPrefix when --in
      // is set narrows it. Reuse the existing projectRoot semantic when no --in.
      const queryRoot =
        opts.in && opts.in.length > 0
          ? scope.pathPrefix.replace(/\/$/, "")
          : projectRoot;

      // Run dependents and tests in parallel. --no-tests skips the test
      // traversal entirely so the affected-tests section is omitted (not just
      // empty) below.
      const [dependents, tests] = await Promise.all([
        findDependents(
          symbols,
          vectorDb,
          queryRoot,
          excludePaths,
          undefined,
          scope.excludePrefixes,
          symbolFamilies,
        ),
        includeTests
          ? findTests(
              symbols,
              vectorDb,
              queryRoot,
              depth,
              scope.excludePrefixes,
              symbolFamilies,
            )
          : Promise.resolve([]),
      ]);

      // Separate test files from non-test dependents
      const nonTestDeps = dependents.filter((d) => !isTestPath(d.file));
      // One line per test file; caller symbols inside it become `via` detail.
      const groupedTests = groupTestHitsByFile(tests);

      const rel = (p: string) =>
        p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;

      if (opts.agent) {
        for (const d of nonTestDeps) {
          console.log(`dep: ${rel(d.file)}\t${d.sharedSymbols}`);
        }
        for (const t of groupedTests) {
          console.log(
            `test: ${rel(t.file)}:${t.line + 1}\t${hopLabelAgent(t.hops)}${formatViaAgent(t.via)}`,
          );
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

        if (includeTests) {
          console.log("");

          if (groupedTests.length > 0) {
            console.log(`Affected tests (${groupedTests.length}):`);
            for (const t of groupedTests) {
              console.log(
                `  ${rel(t.file)}:${t.line + 1}  (${hopLabelHuman(t.hops)}${formatViaHuman(t.via)})`,
              );
            }
          } else {
            console.log("Affected tests: none found");
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Impact analysis failed:", msg);
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
