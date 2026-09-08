import { Command } from "commander";
import {
  callGraphVerb,
  decodeSymbolFamilies,
  type GraphResolveResult,
  runGraphResolve,
  runGraphTests,
} from "../lib/daemon/graph-handler";
import type { TestHit } from "../lib/graph/impact";
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
import { reportStoreAccessRefusal } from "../lib/utils/store-access";

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
            : `Symbol not found: ${target}`,
        );
        process.exitCode = 1;
        return;
      }

      const queryRoot =
        opts.in && opts.in.length > 0
          ? scope.pathPrefix.replace(/\/$/, "")
          : projectRoot;
      const tests = await callGraphVerb<TestHit[]>("graph.tests", {
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
            families: decodeSymbolFamilies(symbolFamilies),
          }),
      });

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
      // A sandbox refusal is already one actionable line; a "Test find failed:"
      // prefix would bury the settings key that fixes it.
      if (!reportStoreAccessRefusal(error)) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("Test find failed:", msg);
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
