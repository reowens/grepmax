import * as path from "node:path";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { formatAgentSearchResults } from "../lib/output/agent-search-formatter";
import {
  formatCompactTable,
  resultCountHeader,
  toCompactHits,
  toTextResults,
} from "../lib/output/compact-results";
import { formatIndexStateFooter } from "../lib/output/index-state-footer";
import { ensureSetup } from "../lib/setup/setup-helpers";
import type { ChunkType, FileMetadata } from "../lib/store/types";
import { VectorDB } from "../lib/store/vector-db";
import {
  type CrossProjectScope,
  groupResultsByProject,
  resolveCrossProjectScope,
} from "../lib/utils/cross-project";
import { gracefulExit } from "../lib/utils/exit";
import { formatTextResults } from "../lib/utils/formatter";
import { extractImports } from "../lib/utils/import-extractor";
import { getProject, resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { getServerForProject } from "../lib/utils/server-registry";
import { runSearch, type SearchOptions } from "./search-run";
import { outputSkeletons } from "./search-skeletons";

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
    "Minimum relevance score (0-1) to include in results",
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
    (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
  )
  .option(
    "--seed-symbol <name>",
    "Bias results toward an identifier you're working with (repeatable; comma-separated also accepted)",
    (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
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

    if (server) {
      try {
        const response = await fetch(`http://localhost:${server.port}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: pattern,
            limit: parseInt(options.m, 10),
            path: exec_path
              ? path.relative(projectRootForServer, path.resolve(exec_path))
              : undefined,
          }),
        });

        if (response.ok) {
          const body = (await response.json()) as { results: any[] };

          const searchResult = { data: body.results };
          const filteredData = searchResult.data.filter(
            (r) => typeof r.score !== "number" || r.score >= minScore,
          );

          if (options.skeleton) {
            await outputSkeletons(
              filteredData,
              projectRootForServer,
              parseInt(options.m, 10),
              // Server doesn't easily expose DB instance here in HTTP client mode,
              // but we are in client. Wait, this text implies "Server Search" block.
              // Client talks to server. The server returns JSON.
              // We don't have DB access here.
              // So we pass null, and it will fallback to generating local skeleton (if file exists locally).
              // This is acceptable for Phase 3.
              null,
            );
            return;
          }

          const compactHits = options.compact
            ? toCompactHits(filteredData)
            : [];

          if (options.compact) {
            if (!compactHits.length) {
              console.log("No matches found.");
              console.log(
                "\nTry: broaden your query, use fewer keywords, or check `gmax status` to verify the project is indexed.",
              );
              process.exitCode = 1;
            } else {
              console.log(
                formatCompactTable(compactHits, projectRootForServer, pattern, {
                  isTTY: !!process.stdout.isTTY,
                  plain: !!options.plain,
                }),
              );
            }
            return; // EXIT
          }

          if (!filteredData.length) {
            console.log("No matches found.");
            console.log(
              "\nTry: broaden your query, use fewer keywords, or check `gmax status` to verify the project is indexed.",
            );
            process.exitCode = 1;
            return; // EXIT
          }

          if (options.agent) {
            const importCache = new Map<string, string>();
            const getImportsForFile = (absPath: string): string => {
              if (!options.imports || !absPath) return "";
              if (!importCache.has(absPath)) {
                importCache.set(absPath, extractImports(absPath));
              }
              return importCache.get(absPath) ?? "";
            };
            console.log(
              formatAgentSearchResults(filteredData, projectRootForServer, {
                includeImports: options.imports,
                getImportsForFile,
                explain: options.explain,
              }),
            );
            return; // EXIT
          }

          const isTTY = process.stdout.isTTY;
          const shouldBePlain = options.plain || !isTTY;

          _searchResultCount = filteredData.length;

          if (!options.agent && !options.compact) {
            console.log(
              resultCountHeader(filteredData, parseInt(options.m, 10)),
            );
            console.log();
          }

          if (shouldBePlain) {
            const mappedResults = toTextResults(filteredData);
            const output = formatTextResults(
              mappedResults,
              pattern,
              projectRootForServer,
              {
                isPlain: true,
                compact: options.compact,
                content: options.content,
                perFile: parseInt(options.perFile, 10),
                showScores: options.scores,
              },
            );
            console.log(output);
          } else {
            const { formatResults } = await import("../lib/output/formatter");
            const output = formatResults(filteredData, projectRootForServer, {
              content: options.content,
              explain: options.explain,
            });
            console.log(output);
          }

          return; // EXIT successful server search
        }
      } catch (e) {
        if (process.env.DEBUG) {
          console.error(
            "[search] server request failed, falling back to local:",
            e,
          );
        }
      }
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
      const seedSymbols = splitSeeds(options.seedSymbol as string[] | undefined);
      const seeds =
        seedFiles || seedSymbols ? { files: seedFiles, symbols: seedSymbols } : undefined;

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
      const { searchResult, precomputedSkeletons, precomputedGraph, indexState } =
        acquired;

      if (!options.agent && searchResult.warnings?.length) {
        for (const w of searchResult.warnings) {
          console.warn(`Warning: ${w}`);
        }
      }

      // Partial-index signal (Phase 6): when the index is mid-catchup, results
      // may be incomplete. Non-agent renders it now as a warning; agent mode
      // appends a machine-readable footer after the results below.
      if (!options.agent) {
        const footer = formatIndexStateFooter(indexState, { agent: false });
        if (footer) console.warn(footer);
      }

      let filteredData = searchResult.data.filter(
        (r) => typeof r.score !== "number" || r.score >= minScore,
      );

      // Post-filter by symbol name regex
      if (options.name) {
        try {
          const regex = new RegExp(options.name, "i");
          filteredData = filteredData.filter((r) => {
            const defs = Array.isArray(r.defined_symbols)
              ? r.defined_symbols
              : [];
            return defs.some((d: string) => regex.test(d));
          });
        } catch {
          // Invalid regex — skip
        }
      }

      // Build import cache when --imports is requested
      const importCache = new Map<string, string>();
      const getImportsForFile = (absPath: string): string => {
        if (!options.imports || !absPath) return "";
        if (!importCache.has(absPath)) {
          importCache.set(absPath, extractImports(absPath));
        }
        return importCache.get(absPath) ?? "";
      };

      // Agent mode: ultra-compact one-line-per-result output
      _searchResultCount = filteredData.length;

      // Cross-project (Phase 6): render grouped by owning project so idioms
      // from different stacks don't blur into one flat list. Only the
      // string-formatter modes reach here — skeleton/context-for-llm/symbol
      // were rejected up front.
      if (crossProject.active) {
        const emitFooter = () => {
          const footer = formatIndexStateFooter(indexState, {
            agent: !!options.agent,
          });
          if (footer) {
            if (options.agent) console.log(footer);
            else console.warn(footer);
          }
        };

        if (!filteredData.length) {
          console.log(options.agent ? "(none)" : "No matches found.");
          process.exitCode = 1;
          emitFooter();
          return;
        }

        const getPath = (r: ChunkType): string =>
          String(
            (r as { path?: string }).path ??
              (r.metadata as FileMetadata | undefined)?.path ??
              "",
          );
        const groups = groupResultsByProject(
          filteredData,
          crossProject.roots,
          getPath,
        );

        const isTTY = process.stdout.isTTY;
        const shouldBePlain = options.plain || !isTTY;
        const blocks: string[] = [];
        for (const g of groups) {
          let body: string;
          if (options.agent) {
            body = formatAgentSearchResults(g.items, g.root, {
              includeImports: options.imports,
              getImportsForFile,
              explain: options.explain,
            });
          } else if (options.compact) {
            body = formatCompactTable(toCompactHits(g.items), g.root, pattern, {
              isTTY: !!isTTY,
              plain: !!options.plain,
            });
          } else if (shouldBePlain) {
            body = formatTextResults(toTextResults(g.items), pattern, g.root, {
              isPlain: true,
              compact: options.compact,
              content: options.content,
              perFile: parseInt(options.perFile, 10),
              showScores: options.scores,
            });
          } else {
            const { formatResults } = await import("../lib/output/formatter");
            body = formatResults(g.items, g.root, {
              content: options.content,
              explain: options.explain,
            });
          }
          const header = options.agent
            ? `## ${g.name} (${g.items.length})`
            : `=== ${g.name} (${g.items.length}) ===`;
          blocks.push(`${header}\n${body}`);
        }
        console.log(blocks.join("\n\n"));
        emitFooter();
        return;
      }

      if (options.agent) {
        if (!filteredData.length) {
          console.log("(none)");
          process.exitCode = 1;
        } else {
          console.log(
            formatAgentSearchResults(filteredData, effectiveRoot, {
              includeImports: options.imports,
              getImportsForFile,
              explain: options.explain,
            }),
          );
        }

        // Agent trace (compact)
        if (options.symbol && filteredData.length > 0) {
          try {
            let graph: any = precomputedGraph;
            if (!graph) {
              if (!vectorDb) throw new Error("no graph source");
              const { GraphBuilder } = await import(
                "../lib/graph/graph-builder"
              );
              const builder = new GraphBuilder(vectorDb, effectiveRoot);
              graph = await builder.buildGraphMultiHop(pattern, 1);
            }
            if (graph?.center) {
              console.log("---");
              for (const t of graph.callerTree) {
                const rel = t.node.file.startsWith(effectiveRoot)
                  ? t.node.file.slice(effectiveRoot.length + 1)
                  : t.node.file;
                console.log(`<- ${t.node.symbol} ${rel}:${t.node.line + 1}`);
              }
              for (const c of graph.callees.slice(0, 10)) {
                if (c.file) {
                  const rel = c.file.startsWith(effectiveRoot)
                    ? c.file.slice(effectiveRoot.length + 1)
                    : c.file;
                  console.log(`-> ${c.symbol} ${rel}:${c.line + 1}`);
                }
              }
            }
          } catch {}
        }

        // Partial-index footer last, so it's the final line the agent reads —
        // and emitted even on "(none)", where an empty result may just mean the
        // relevant files aren't indexed yet.
        const footer = formatIndexStateFooter(indexState, { agent: true });
        if (footer) console.log(footer);
        return;
      }

      if (options.skeleton) {
        await outputSkeletons(
          filteredData,
          projectRoot,
          parseInt(options.m, 10),
          vectorDb,
          precomputedSkeletons,
        );
        return;
      }

      if (!filteredData.length) {
        console.log("No matches found.");
        console.log(
          "\nTry: broaden your query, use fewer keywords, or check `gmax status` to verify the project is indexed.",
        );
        process.exitCode = 1;
        return;
      }

      if (options.compact) {
        const compactHits = toCompactHits(filteredData);
        console.log(
          formatCompactTable(compactHits, projectRoot, pattern, {
            isTTY: !!process.stdout.isTTY,
            plain: !!options.plain,
          }),
        );
        return;
      }

      _searchResultCount = filteredData.length;

      // Context-for-LLM mode: full function body + imports per result
      if (options.contextForLlm) {
        const fs = await import("node:fs");
        const { extractImportsFromContent } = await import(
          "../lib/utils/import-extractor"
        );
        const { packByBudget } = await import("../lib/utils/budget-pack");
        const budget = parseInt(options.budget, 10) || 8000;

        console.log(resultCountHeader(filteredData, parseInt(options.m, 10)));

        // Build every candidate blob up front (token cost needs the rendered
        // text), then pack to budget. Token-aware packing skips an oversized
        // chunk and keeps filling with smaller, still-relevant ones rather than
        // aborting the loop — recovering budget the old greedy `break` wasted.
        const candidates = filteredData.map((r, idx) => {
          const absP = (r as any).path ?? (r as any).metadata?.path ?? "";
          const startLine =
            (r as any).startLine ??
            (r as any).start_line ??
            (r as any).generated_metadata?.start_line ??
            0;
          const endLine =
            (r as any).endLine ??
            (r as any).end_line ??
            (r as any).generated_metadata?.end_line ??
            startLine;
          const relPath = absP.startsWith(projectRoot)
            ? absP.slice(projectRoot.length + 1)
            : absP;
          const role = (r as any).role || "IMPLEMENTATION";
          const symbol =
            Array.isArray((r as any).defined_symbols) &&
            (r as any).defined_symbols.length > 0
              ? (r as any).defined_symbols[0]
              : "";

          let blobText: string;
          try {
            const content = fs.readFileSync(absP, "utf-8");
            const allLines = content.split("\n");
            const body = allLines
              .slice(startLine, Math.min(endLine + 1, allLines.length))
              .join("\n");
            const imports = extractImportsFromContent(content);
            const blob = [
              `--- ${relPath}:${startLine + 1}${symbol ? ` ${symbol}` : ""} [${role}] ---`,
            ];
            if (imports) blob.push("[imports]", imports, "");
            blob.push("[body]", body);
            blobText = blob.join("\n");
          } catch {
            blobText = `--- ${relPath} (file not readable) ---`;
          }

          // Preserve relevance order when scores are absent (rank-derived
          // fallback) so the density tiebreaker never reshuffles arbitrarily.
          const score =
            typeof r.score === "number"
              ? r.score
              : (filteredData.length - idx) / filteredData.length;
          return { blobText, tokens: Math.ceil(blobText.length / 4), score };
        });

        const pack = packByBudget(
          candidates.map((c) => ({ tokens: c.tokens, score: c.score })),
          budget,
        );
        for (const i of pack.selected) {
          console.log(`\n${candidates[i].blobText}`);
        }
        if (pack.dropped > 0) {
          console.log(
            `\n(budget: ~${pack.tokensUsed}/${budget} tokens, ${pack.dropped} lower-density result${pack.dropped > 1 ? "s" : ""} not shown)`,
          );
        }
        return;
      }

      const isTTY = process.stdout.isTTY;
      const shouldBePlain = options.plain || !isTTY;

      if (!options.agent && !options.compact) {
        console.log(resultCountHeader(filteredData, parseInt(options.m, 10)));
        console.log();
      }

      // Print imports per unique file before results when --imports is used
      if (options.imports) {
        const seenFiles = new Set<string>();
        for (const r of filteredData) {
          const absP = (r as any).path ?? (r as any).metadata?.path ?? "";
          if (absP && !seenFiles.has(absP)) {
            seenFiles.add(absP);
            const imports = getImportsForFile(absP);
            if (imports) {
              const relP = absP.startsWith(effectiveRoot)
                ? absP.slice(effectiveRoot.length + 1)
                : absP;
              console.log(`--- imports: ${relP} ---\n${imports}\n`);
            }
          }
        }
      }

      if (shouldBePlain) {
        const mappedResults = toTextResults(filteredData);
        const output = formatTextResults(mappedResults, pattern, projectRoot, {
          isPlain: true,
          compact: options.compact,
          content: options.content,
          perFile: parseInt(options.perFile, 10),
          showScores: options.scores,
        });
        console.log(output);
        if (options.explain) {
          for (const r of filteredData) {
            const b = (r as any).scoreBreakdown;
            if (b) {
              const absP = (r as any).path ?? (r as any).metadata?.path ?? "";
              const relPath = absP.startsWith(projectRoot)
                ? absP.slice(projectRoot.length + 1)
                : absP;
              console.log(
                `  [explain ${relPath}] rerank=${b.rerank.toFixed(3)}  fused=${b.fused.toFixed(3)}  boost=${b.boost.toFixed(2)}x  final=${b.normalized.toFixed(3)}`,
              );
            }
          }
        }
      } else {
        // Use new holographic formatter for TTY
        const { formatResults } = await import("../lib/output/formatter");
        const output = formatResults(filteredData, projectRoot, {
          content: options.content,
          explain: options.explain,
        });
        console.log(output);
      }

      // Symbol mode: append call graph
      if (options.symbol) {
        try {
          let graph: any = precomputedGraph;
          if (!graph) {
            if (!vectorDb) throw new Error("no graph source");
            const { GraphBuilder } = await import("../lib/graph/graph-builder");
            const builder = new GraphBuilder(vectorDb, effectiveRoot);
            graph = await builder.buildGraphMultiHop(pattern, 1);
          }
          if (graph?.center) {
            const lines: string[] = ["\n--- Call graph ---"];
            const centerRel = path.relative(effectiveRoot, graph.center.file);
            lines.push(
              `${graph.center.symbol} [${graph.center.role}] ${centerRel}:${graph.center.line + 1}`,
            );
            if (graph.importers.length > 0) {
              const filtered = graph.importers.filter(
                (p: string) => p !== graph.center.file,
              );
              if (filtered.length > 0) {
                lines.push("Imported by:");
                for (const imp of filtered.slice(0, 10)) {
                  lines.push(`  ${path.relative(effectiveRoot, imp)}`);
                }
              }
            }
            if (graph.callerTree.length > 0) {
              lines.push("Callers:");
              for (const t of graph.callerTree) {
                lines.push(
                  `  <- ${t.node.symbol} ${path.relative(effectiveRoot, t.node.file)}:${t.node.line + 1}`,
                );
              }
            }
            if (graph.callees.length > 0) {
              lines.push("Calls:");
              for (const c of graph.callees.slice(0, 15)) {
                if (c.file) {
                  lines.push(
                    `  -> ${c.symbol} ${path.relative(effectiveRoot, c.file)}:${c.line + 1}`,
                  );
                } else {
                  lines.push(`  -> ${c.symbol} (not indexed)`);
                }
              }
            }
            console.log(lines.join("\n"));
          }
        } catch {
          // Trace failed — skip silently
        }
      }
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
