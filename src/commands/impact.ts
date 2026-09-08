import * as path from "node:path";
import { Command } from "commander";
import {
  callGraphVerb,
  decodeSymbolFamilies,
  type GraphResolveResult,
  runGraphDependents,
  runGraphResolve,
  runGraphTests,
} from "../lib/daemon/graph-handler";
import {
  type DependentHit,
  type DetailedDependentHit,
  isTestPath,
  type TestHit,
} from "../lib/graph/impact";
import {
  buildImpactRollup,
  formatImpactRollupAgent,
  formatImpactRollupHuman,
} from "../lib/graph/impact-rollup";
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
import { reportStoreAccessRefusal } from "../lib/utils/store-access";

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
  .option(
    "--rollup",
    "Show export/package rollup (default for file targets in human output)",
    false,
  )
  .option("--flat", "Use the legacy flat dependent/test list", false)
  .option("--top <n>", "Max rows per rollup section", "10")
  .option("--agent", "Compact output for AI agents", false)
  .action(async (target, opts) => {
    const depth = Math.min(
      Math.max(Number.parseInt(opts.depth || "1", 10), 1),
      3,
    );
    // commander maps --no-tests → opts.tests === false (defaults true).
    const includeTests = opts.tests !== false;
    const top = Math.min(
      Math.max(Number.parseInt(opts.top || "10", 10) || 10, 1),
      100,
    );
    // Opened only if the daemon is unreachable; withStoreRead decides.
    const local: { db: VectorDB | null } = { db: null };

    try {
      const root = resolveRootOrExit(opts.root);
      if (root === null) return;
      const projectRoot = findProjectRoot(root) ?? root;
      maybeWarnStaleChunker(projectRoot, { agent: opts.agent });
      maybeWarnStaleEmbedding(projectRoot, { agent: opts.agent });
      const localDb = () => {
        local.db ??= new VectorDB(ensureProjectPaths(projectRoot).lancedbDir);
        return local.db;
      };

      const { resolveScope } = await import("../lib/utils/scope-filter");
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });

      const { symbols, resolvedAsFile, symbolFamilies } =
        await callGraphVerb<GraphResolveResult>("graph.resolve", {
          projectRoot,
          scope,
          payload: { target },
          render: (resp) => ({
            symbols: (resp.symbols as string[]) ?? [],
            resolvedAsFile: resp.resolvedAsFile === true,
            symbolFamilies:
              (resp.symbolFamilies as GraphResolveResult["symbolFamilies"]) ??
              null,
          }),
          inProcess: () => runGraphResolve(localDb(), { target, projectRoot }),
        });

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
      const excludePaths = targetPath ? [targetPath] : undefined;

      // Treat --in as an exclude-everything-else when set: any prefix that
      // isn't the --in scope becomes effectively excluded. Today findDependents
      // always queries within projectRoot; passing scope.pathPrefix when --in
      // is set narrows it. Reuse the existing projectRoot semantic when no --in.
      const queryRoot =
        opts.in && opts.in.length > 0
          ? scope.pathPrefix.replace(/\/$/, "")
          : projectRoot;
      const useRollup =
        !opts.flat && ((resolvedAsFile && !opts.agent) || opts.rollup === true);
      const rollupLimit = Math.min(Math.max(top * 10, 100), 500);
      const families = decodeSymbolFamilies(symbolFamilies);

      // Run dependents and tests in parallel. --no-tests skips the test
      // traversal entirely so the affected-tests section is omitted (not just
      // empty) below.
      const [dependents, tests] = await Promise.all([
        callGraphVerb<DependentHit[] | DetailedDependentHit[]>(
          "graph.dependents",
          {
            projectRoot,
            scope,
            payload: {
              symbols,
              detailed: useRollup,
              excludePaths,
              limit: useRollup ? rollupLimit : undefined,
              families: symbolFamilies,
            },
            render: (resp) => (resp.dependents as DependentHit[]) ?? [],
            inProcess: () =>
              runGraphDependents(localDb(), {
                symbols,
                queryRoot,
                detailed: useRollup,
                excludePaths,
                limit: useRollup ? rollupLimit : undefined,
                excludePrefixes: scope.excludePrefixes,
                families,
              }),
          },
        ),
        includeTests
          ? callGraphVerb<TestHit[]>("graph.tests", {
              projectRoot,
              scope,
              payload: { symbols, depth, families: symbolFamilies },
              render: (resp) => (resp.hits as TestHit[]) ?? [],
              inProcess: () =>
                runGraphTests(localDb(), {
                  symbols,
                  queryRoot,
                  depth,
                  excludePrefixes: scope.excludePrefixes,
                  families,
                }),
            })
          : Promise.resolve([] as TestHit[]),
      ]);

      if (useRollup) {
        const detailedDependents = dependents as DetailedDependentHit[];
        const rollup = buildImpactRollup({
          targetSymbols: symbols,
          dependents: detailedDependents,
          tests,
          projectRoot,
          top,
        });
        const formatted = opts.agent
          ? formatImpactRollupAgent(rollup, {
              target,
              projectRoot,
              includeTests,
            })
          : formatImpactRollupHuman(rollup, {
              target,
              projectRoot,
              includeTests,
            });
        console.log(formatted);
        return;
      }

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
      // A sandbox refusal is already one actionable line; the "Impact analysis
      // failed:" prefix would bury the settings key that fixes it.
      if (!reportStoreAccessRefusal(error)) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("Impact analysis failed:", msg);
        process.exitCode = 1;
      }
    } finally {
      if (local.db) {
        try {
          await local.db.close();
        } catch {}
      }
      await gracefulExit();
    }
  });
