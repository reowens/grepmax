import * as path from "node:path";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { ensureSetup } from "../lib/setup/setup-helpers";
import type { VectorDB } from "../lib/store/vector-db";
import {
  type CrossProjectScope,
  resolveCrossProjectScope,
} from "../lib/utils/cross-project";
import { gracefulExit } from "../lib/utils/exit";
import { getProject, resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { getServerForProject } from "../lib/utils/server-registry";
import {
  maybeWarnCrossProjectDim,
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";
import { executeServerSearch, renderSearchOutput } from "./search-output";
import { runSearch, type SearchOptions } from "./search-run";

export const search: Command = new CommanderCommand("search")
  .description("Search code by meaning (default command)")
  .option(
    "-m <max_count>, --max-count <max_count>",
    "The maximum number of results to return (total)",
    "5",
  )
  .option("-c, --content", "Show full chunk content instead of snippets", false)
  .option("--per-file <n>", "Number of matches to show per file", "3")
  .option("--scores", "Show relevance scores", false)
  .option("--explain", "Show scoring breakdown per result", false)
  .option(
    "--context-for-llm",
    "Return full function body + imports per result",
    false,
  )
  .option(
    "--budget <tokens>",
    "Max tokens for --context-for-llm output (default 8000)",
    "8000",
  )
  .option(
    "--min-score <score>",
    "Minimum relevance score to include. Scores are per-query-normalized (top hit = 1.0), so this is relative to the best match in THIS query, not an absolute confidence threshold.",
    "0",
  )
  .option(
    "--compact",
    "Compact hits view (paths + line ranges + role/preview)",
    false,
  )
  .option("--plain", "Disable ANSI colors and use simpler formatting", false)

  .option(
    "-s, --sync",
    "Syncs the local files to the store before searching",
    false,
  )
  .option(
    "-d, --dry-run",
    "Show what would be indexed without actually indexing",
    false,
  )
  .option(
    "--skeleton",
    "Show code skeleton for matching files instead of snippets",
    false,
  )
  .option("--root <dir>", "Search a different project directory")
  .option(
    "--file <name>",
    "Filter to files matching this name (e.g. 'syncer.ts')",
  )
  .option(
    "--in <subpath>",
    "Restrict to a sub-path of the project (repeatable; comma-separated also accepted)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option(
    "--exclude <subpath>",
    "Exclude a sub-path of the project (repeatable; e.g. 'tests/')",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option(
    "--all-projects",
    "Search across every indexed project, not just the current one",
    false,
  )
  .option(
    "--projects <list>",
    "Search only these indexed projects (comma-separated names)",
  )
  .option(
    "--exclude-projects <list>",
    "With --all-projects, skip these projects (comma-separated names)",
  )
  .option("--lang <ext>", "Filter by file extension (e.g. 'ts', 'py')")
  .option(
    "--role <role>",
    "Filter by role: ORCHESTRATION, DEFINITION, IMPLEMENTATION",
  )
  .option("--symbol", "Append call graph after search results", false)
  .option("--imports", "Prepend file imports to each result", false)
  .option("--name <regex>", "Filter results by symbol name regex")
  .option("-C, --context <n>", "Include N lines before/after each result")
  .option(
    "--agent",
    "Ultra-compact output for AI agents (one line per result)",
    false,
  )
  .option(
    "--seed-file <path>",
    "Bias results toward your working context (repeatable; comma-separated also accepted)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option(
    "--seed-symbol <name>",
    "Bias results toward an identifier you're working with (repeatable; comma-separated also accepted)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .argument(
    "<pattern>",
    'Natural language query (e.g. "where do we handle auth?")',
  )
  .argument("[path]", "Restrict search to this path prefix")
  .addHelpText(
    "after",
    `
Examples:
  gmax "where do we handle authentication?"
  gmax "auth handler" --role ORCHESTRATION --lang ts --plain
  gmax "database" --file syncer.ts --plain
  gmax "VectorDB" --symbol --plain
  gmax "error handling" -C 5 --imports --plain
  gmax "handler" --name "handle.*" --exclude tests/
  gmax "rate limiter" --all-projects --agent
  gmax "auth middleware" --projects api,gateway --plain
`,
  )
  .action(async (pattern, exec_path, _options, cmd) => {
    const options: SearchOptions = cmd.optsWithGlobals();

    const root = process.cwd();
    const minScore = Number.isFinite(Number.parseFloat(options.minScore))
      ? Number.parseFloat(options.minScore)
      : 0;
    let vectorDb: VectorDB | null = null;
    const _searchStartMs = Date.now();
    let _searchResultCount = 0;
    let _searchError: string | undefined;

    // Cross-project scope (Phase 6): --all-projects / --projects / --exclude-projects.
    // When active, single-project path scoping is dropped in favor of the
    // project_roots filter clauses, and results are grouped by owning project.
    const crossProject: CrossProjectScope = resolveCrossProjectScope({
      allProjects: options.allProjects,
      projects: options.projects,
      excludeProjects: options.excludeProjects,
    });
    if (crossProject.active) {
      // These modifiers are inherently single-project (one skeleton root, one
      // call-graph center, one budget rollup). Reject the combination up front
      // rather than emit confusing cross-root output.
      const conflict = options.skeleton
        ? "--skeleton"
        : options.contextForLlm
          ? "--context-for-llm"
          : options.symbol
            ? "--symbol"
            : null;
      if (conflict) {
        console.error(
          `${conflict} is single-project; drop --all-projects/--projects or ${conflict}.`,
        );
        process.exitCode = 1;
        return;
      }
      for (const w of crossProject.warnings) console.warn(`Warning: ${w}`);
      if (!crossProject.roots.length) {
        console.error(
          "No matching indexed projects. Run `gmax status` to list them.",
        );
        process.exitCode = 1;
        return;
      }
    }

    // Check for running server. The per-project HTTP server can't answer
    // cross-project queries, so cross-project mode skips it and uses the
    // daemon-mediated / in-process path (both query the shared table).
    const execPathForServer = exec_path ? path.resolve(exec_path) : root;
    const projectRootForServer =
      findProjectRoot(execPathForServer) ?? execPathForServer;
    const server = crossProject.active
      ? null
      : getServerForProject(projectRootForServer);

    // The standalone HTTP-server path lives OUTSIDE the main try/finally below:
    // a handled server search returns here, intentionally skipping query
    // logging and gracefulExit (unchanged from before the extraction).
    if (server) {
      const handled = await executeServerSearch({
        server,
        pattern,
        exec_path,
        projectRootForServer,
        options,
        minScore,
      });
      if (handled) return;
    }

    try {
      await ensureSetup();
      const searchRoot = exec_path ? path.resolve(exec_path) : root;
      const projectRoot = findProjectRoot(searchRoot) ?? searchRoot;
      const paths = ensureProjectPaths(projectRoot);

      // Propagate project root to worker processes
      process.env.GMAX_PROJECT_ROOT = projectRoot;

      // Check if project is registered
      let checkRoot: string;
      if (options.root) {
        const resolved = resolveRootOrExit(options.root);
        if (resolved === null) return;
        checkRoot = findProjectRoot(resolved) ?? resolved;
      } else {
        checkRoot = projectRoot;
      }
      const project = getProject(checkRoot);
      if (!project) {
        console.error(
          `This project hasn't been added to gmax yet.\n\nRun: gmax add ${checkRoot}\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (project.status === "pending") {
        console.warn(
          "This project is still being indexed. Results may be incomplete.\n",
        );
      }
      maybeWarnStaleChunker(checkRoot, { agent: options.agent });
      maybeWarnStaleEmbedding(checkRoot, { agent: options.agent });
      if (crossProject.active) {
        maybeWarnCrossProjectDim(crossProject.roots, { agent: options.agent });
      }

      // Compute effective paths + filters early — both the daemon-mediated
      // and in-process search paths need them. Reuse the resolved checkRoot
      // so --root <name> only resolves once per invocation.
      const effectiveRoot = checkRoot;

      // --in / --exclude / [path positional] composition. --in wins over the
      // positional [path] when both are given (positional was the older
      // shape; --in is canonical going forward).
      if (exec_path && options.in && options.in.length > 0) {
        console.warn("Warning: --in overrides positional [path]; using --in.");
      }
      const { resolveScope } = await import("../lib/utils/scope-filter");
      const scope = resolveScope({
        projectRoot: effectiveRoot,
        in: options.in,
        exclude: options.exclude,
      });
      // Cross-project mode drops the single-project path prefix (and any
      // --in/[path] sub-scoping, which is meaningless across roots) in favor of
      // the project_roots filter clauses computed below.
      if (crossProject.active && (exec_path || options.in?.length)) {
        console.warn(
          "Warning: --in / [path] are single-project; ignored under --all-projects/--projects.",
        );
      }
      const pathFilter = crossProject.active
        ? undefined
        : options.in && options.in.length > 0
          ? scope.pathPrefix
          : exec_path
            ? (() => {
                const p = path.resolve(exec_path);
                return p.endsWith("/") ? p : `${p}/`;
              })()
            : scope.pathPrefix;
      const searchFilters: Record<string, unknown> = {};
      if (options.file) searchFilters.file = options.file;
      if (options.lang) searchFilters.language = options.lang;
      if (options.role) searchFilters.role = options.role;
      if (crossProject.active) {
        if (crossProject.projectRootsCsv)
          searchFilters.project_roots = crossProject.projectRootsCsv;
        if (crossProject.excludeProjectRootsCsv)
          searchFilters.exclude_project_roots =
            crossProject.excludeProjectRootsCsv;
      } else {
        if (scope.inPrefixes.length > 0)
          searchFilters.inPrefixes = scope.inPrefixes;
        if (scope.excludePrefixes.length > 0)
          searchFilters.excludePrefixes = scope.excludePrefixes;
      }

      // Aider-style seeding: --seed-file / --seed-symbol (repeatable, also
      // comma-separated) bias candidate generation toward the caller's working
      // context. Absent → undefined → inert.
      const splitSeeds = (vals: string[] | undefined): string[] | undefined => {
        const items = (vals ?? [])
          .flatMap((v) => v.split(","))
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        return items.length > 0 ? items : undefined;
      };
      const seedFiles = splitSeeds(options.seedFile as string[] | undefined);
      const seedSymbols = splitSeeds(
        options.seedSymbol as string[] | undefined,
      );
      const seeds =
        seedFiles || seedSymbols
          ? { files: seedFiles, symbols: seedSymbols }
          : undefined;

      // Acquire results: daemon-mediated first, in-process fallback otherwise.
      // The render stage below is shared across both. `runSearch` reports the
      // VectorDB it opens via the callback so the `finally` can close it.
      const acquired = await runSearch({
        pattern,
        options,
        projectRoot,
        effectiveRoot,
        paths,
        projectStatus: project.status,
        searchFilters,
        pathFilter,
        seeds,
      });
      vectorDb = acquired.vectorDb;
      if (acquired.kind === "dry-run") return;
      const {
        searchResult,
        precomputedSkeletons,
        precomputedGraph,
        indexState,
      } = acquired;

      // Presentation stage (shared by daemon-mediated + in-process paths):
      // min-score/name post-filters + the 7-mode render switch live in
      // renderSearchOutput; it returns the post-filter count for query logging.
      const { resultCount } = await renderSearchOutput({
        searchResult,
        options,
        minScore,
        crossProject,
        pattern,
        effectiveRoot,
        projectRoot,
        vectorDb,
        precomputedSkeletons,
        precomputedGraph,
        indexState,
      });
      _searchResultCount = resultCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      _searchError = message;
      console.error("Search failed:", message);
      process.exitCode = 1;
    } finally {
      // Best-effort query logging
      try {
        const { logQuery } = await import("../lib/utils/query-log");
        logQuery({
          ts: new Date().toISOString(),
          source: "cli",
          tool: "search",
          query: pattern,
          project: findProjectRoot(root) ?? root,
          results: _searchResultCount,
          ms: Date.now() - _searchStartMs,
          error: _searchError,
        });
      } catch {}
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch (err) {
          console.error("Failed to close VectorDB:", err);
        }
      }
      await gracefulExit();
    }
  });
