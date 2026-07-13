import * as path from "node:path";
import { formatAgentSearchResults } from "../lib/output/agent-search-formatter";
import {
  formatCompactTable,
  resultCountHeader,
  toCompactHits,
  toTextResults,
} from "../lib/output/compact-results";
import {
  formatIndexStateFooter,
  type IndexState,
} from "../lib/output/index-state-footer";
import type {
  ChunkType,
  FileMetadata,
  SearchResponse,
} from "../lib/store/types";
import type { VectorDB } from "../lib/store/vector-db";
import {
  type CrossProjectScope,
  groupResultsByProject,
} from "../lib/utils/cross-project";
import { formatTextResults } from "../lib/utils/formatter";
import { extractImports } from "../lib/utils/import-extractor";
import { resolveContainedFile } from "../lib/utils/path-containment";
import type { SearchOptions } from "./search-run";
import { outputSkeletons } from "./search-skeletons";

/**
 * Standalone HTTP-server search path. The per-project server answers the query
 * over HTTP and returns JSON; we render it here with the same presentation
 * modes as the local path (minus the modes the server can't precompute).
 *
 * Returns `true` when the server answered and rendering is complete (the caller
 * should return without touching the local path); `false` when the request
 * failed (`!response.ok` or a thrown error) and the caller should fall back to
 * the in-process / daemon-mediated path.
 *
 * Mirrors the original action's structure: a handled server search returns
 * BEFORE the command's main try/finally, so it intentionally skips query
 * logging and gracefulExit.
 */
export async function executeServerSearch(params: {
  server: { port: number };
  pattern: string;
  exec_path: string | undefined;
  projectRootForServer: string;
  options: SearchOptions;
  minScore: number;
}): Promise<boolean> {
  const {
    server,
    pattern,
    exec_path,
    projectRootForServer,
    options,
    minScore,
  } = params;

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: pattern,
        limit: parseInt(options.m, 10),
        path: exec_path
          ? path.relative(projectRootForServer, path.resolve(exec_path))
          : undefined,
        in: options.in,
        exclude: options.exclude,
        file: options.file,
        lang: options.lang,
        role: options.role,
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
        return true;
      }

      const compactHits = options.compact ? toCompactHits(filteredData) : [];

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
        return true; // EXIT
      }

      if (!filteredData.length) {
        console.log("No matches found.");
        console.log(
          "\nTry: broaden your query, use fewer keywords, or check `gmax status` to verify the project is indexed.",
        );
        process.exitCode = 1;
        return true; // EXIT
      }

      if (options.agent) {
        const importCache = new Map<string, string>();
        const getImportsForFile = (indexedPath: string): string => {
          let absPath: string;
          try {
            absPath = resolveContainedFile(projectRootForServer, indexedPath);
          } catch {
            return "";
          }
          if (!options.imports || !absPath) return "";
          if (!importCache.has(absPath)) {
            importCache.set(absPath, extractImports(absPath));
          }
          return importCache.get(absPath) ?? "";
        };
        console.log(
          formatAgentSearchResults(filteredData, projectRootForServer, {
            includeImports: options.imports,
            query: pattern,
            getImportsForFile,
            explain: options.explain,
          }),
        );
        return true; // EXIT
      }

      const isTTY = process.stdout.isTTY;
      const shouldBePlain = options.plain || !isTTY;

      if (!options.agent && !options.compact) {
        console.log(resultCountHeader(filteredData, parseInt(options.m, 10)));
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

      return true; // EXIT successful server search
    }
  } catch (e) {
    if (process.env.DEBUG) {
      console.error(
        "[search] server request failed, falling back to local:",
        e,
      );
    }
  }
  return false;
}

export interface RenderSearchParams {
  searchResult: SearchResponse;
  options: SearchOptions;
  minScore: number;
  crossProject: CrossProjectScope;
  pattern: string;
  effectiveRoot: string;
  projectRoot: string;
  vectorDb: VectorDB | null;
  precomputedSkeletons?: Record<string, string>;
  precomputedGraph?: any;
  indexState?: IndexState;
}

/**
 * Presentation stage shared by the daemon-mediated and in-process search paths.
 * Applies the min-score + name-regex post-filters, then dispatches to one of the
 * seven presentation modes (cross-project, agent, skeleton, no-results, compact,
 * context-for-llm, standard). Writes directly to stdout/stderr and may set
 * `process.exitCode`. Returns the post-filter result count for query logging.
 */
export async function renderSearchOutput(
  params: RenderSearchParams,
): Promise<{ resultCount: number }> {
  const {
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
  } = params;

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
        const defs = Array.isArray(r.defined_symbols) ? r.defined_symbols : [];
        return defs.some((d: string) => regex.test(d));
      });
    } catch {
      // Invalid regex — skip
    }
  }

  // Build import cache when --imports is requested
  const importCache = new Map<string, string>();
  const getImportsForRoot =
    (root: string) =>
    (indexedPath: string): string => {
      if (!options.imports || !indexedPath) return "";
      let absPath: string;
      try {
        absPath = resolveContainedFile(root, indexedPath);
      } catch {
        return "";
      }
      if (!importCache.has(absPath)) {
        importCache.set(absPath, extractImports(absPath));
      }
      return importCache.get(absPath) ?? "";
    };
  const getImportsForFile = getImportsForRoot(effectiveRoot);

  // Agent mode: ultra-compact one-line-per-result output
  const resultCount = filteredData.length;

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
      return { resultCount };
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
          query: pattern,
          getImportsForFile: getImportsForRoot(g.root),
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
    return { resultCount };
  }

  if (options.agent) {
    if (!filteredData.length) {
      console.log("(none)");
      process.exitCode = 1;
    } else {
      console.log(
        formatAgentSearchResults(filteredData, effectiveRoot, {
          includeImports: options.imports,
          query: pattern,
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
          const { GraphBuilder } = await import("../lib/graph/graph-builder");
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
    return { resultCount };
  }

  if (options.skeleton) {
    await outputSkeletons(
      filteredData,
      projectRoot,
      parseInt(options.m, 10),
      vectorDb,
      precomputedSkeletons,
    );
    return { resultCount };
  }

  if (!filteredData.length) {
    console.log("No matches found.");
    console.log(
      "\nTry: broaden your query, use fewer keywords, or check `gmax status` to verify the project is indexed.",
    );
    process.exitCode = 1;
    return { resultCount };
  }

  if (options.compact) {
    const compactHits = toCompactHits(filteredData);
    console.log(
      formatCompactTable(compactHits, projectRoot, pattern, {
        isTTY: !!process.stdout.isTTY,
        plain: !!options.plain,
      }),
    );
    return { resultCount };
  }

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
      const indexedPath = (r as any).path ?? (r as any).metadata?.path ?? "";
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
      let relPath = "(invalid indexed path)";
      const role = (r as any).role || "IMPLEMENTATION";
      const symbol =
        Array.isArray((r as any).defined_symbols) &&
        (r as any).defined_symbols.length > 0
          ? (r as any).defined_symbols[0]
          : "";

      let blobText: string;
      try {
        const absP = resolveContainedFile(projectRoot, indexedPath);
        relPath = path.relative(fs.realpathSync(projectRoot), absP);
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
    return { resultCount };
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

  return { resultCount };
}
