import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import { MODEL_TIERS, PATHS } from "../config";
import { type CallerTree, GraphBuilder } from "../lib/graph/graph-builder";
import { readGlobalConfig, readIndexConfig } from "../lib/index/index-config";
import { generateSummaries } from "../lib/index/syncer";
import { MetaCache } from "../lib/store/meta-cache";
import { Searcher } from "../lib/search/searcher";
import { annotateSkeletonLines } from "../lib/skeleton/annotator";
import { getStoredSkeleton } from "../lib/skeleton/retriever";
import { extractSymbolsFromSkeleton } from "../lib/skeleton/symbol-extractor";
import { Skeletonizer } from "../lib/skeleton/skeletonizer";
import { VectorDB } from "../lib/store/vector-db";
import { isIndexableFile } from "../lib/utils/file-utils";
import { escapeSqlString, normalizePath } from "../lib/utils/filter-builder";
import { formatTimeAgo } from "../lib/utils/format-helpers";
import { extractImports } from "../lib/utils/import-extractor";
import { listProjects } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { launchWatcher } from "../lib/utils/watcher-launcher";
import { getWatcherCoveringPath } from "../lib/utils/watcher-store";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "semantic_search",
    description:
      "Search code by meaning. Use scope:'all' for cross-project. Prefer CLI: gmax \"query\" --plain",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language query (5+ words recommended)" },
        limit: { type: "number", description: "Max results (default 3, max 50)" },
        root: { type: "string", description: "Search a different directory (absolute path)" },
        path: { type: "string", description: "Path prefix filter (e.g. 'src/auth/')" },
        detail: { type: "string", description: "'pointer' (default), 'code', or 'full'" },
        min_score: { type: "number", description: "Min score 0-1 (default 0)" },
        max_per_file: { type: "number", description: "Max results per file" },
        file: { type: "string", description: "Filename filter (e.g. 'syncer.ts')" },
        exclude: { type: "string", description: "Exclude path prefix (e.g. 'tests/')" },
        language: { type: "string", description: "Extension filter (e.g. 'ts', 'py')" },
        role: { type: "string", description: "'ORCHESTRATION', 'DEFINITION', or 'IMPLEMENTATION'" },
        context_lines: { type: "number", description: "Lines before/after chunk (max 20)" },
        mode: { type: "string", description: "'default' or 'symbol' (appends call graph)" },
        include_imports: { type: "boolean", description: "Prepend file imports to results" },
        name_pattern: { type: "string", description: "Regex filter on symbol name" },
        scope: { type: "string", description: "'project' (default) or 'all' (search everything)" },
        projects: { type: "string", description: "Project names to include (comma-separated)" },
        exclude_projects: { type: "string", description: "Project names to exclude (comma-separated)" },
      },
      required: ["query"],
    },
  },
  {
    name: "code_skeleton",
    description:
      "File structure with bodies collapsed (~4x fewer tokens). Accepts file, directory, or comma-separated paths.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: { type: "string", description: "File, directory, or comma-separated paths" },
        limit: { type: "number", description: "Max files for directory mode (default 10)" },
        format: { type: "string", description: "'text' (default) or 'json'" },
      },
      required: ["target"],
    },
  },
  {
    name: "trace_calls",
    description: "Call graph: importers, callers (multi-hop), callees with file:line.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Function/class name to trace" },
        depth: { type: "number", description: "Caller depth (default 1, max 3)" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "extract_symbol",
    description: "Extract complete function/class body by symbol name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Symbol name to extract" },
        root: { type: "string", description: "Project root (absolute path)" },
        include_imports: { type: "boolean", description: "Prepend file imports" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "peek_symbol",
    description: "Compact symbol overview: signature + callers + callees.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Symbol name" },
        root: { type: "string", description: "Project root (absolute path)" },
        depth: { type: "number", description: "Caller depth (default 1, max 3)" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "list_symbols",
    description: "List indexed symbols with role and export status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Name filter (case-insensitive)" },
        limit: { type: "number", description: "Max results (default 20)" },
        path: { type: "string", description: "Path prefix filter" },
      },
    },
  },
  {
    name: "index_status",
    description: "Index health: chunks, files, projects, watcher status.",
    inputSchema: { type: "object" as const, properties: {} },
    _meta: { "anthropic/alwaysLoad": true },
  },
  {
    name: "summarize_directory",
    description: "Generate LLM summaries for indexed chunks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Directory to summarize (default: project root)" },
        limit: { type: "number", description: "Max chunks (default 200, max 5000)" },
      },
    },
  },
  {
    name: "summarize_project",
    description: "Project overview: languages, structure, roles, key symbols, entry points.",
    inputSchema: {
      type: "object" as const,
      properties: {
        root: { type: "string", description: "Project root (default: current)" },
      },
    },
  },
  {
    name: "related_files",
    description: "Find dependencies and dependents of a file by shared symbols.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file: { type: "string", description: "File path relative to project root" },
        limit: { type: "number", description: "Max results per direction (default 10)" },
      },
      required: ["file"],
    },
  },
  {
    name: "recent_changes",
    description: "Recently modified indexed files with timestamps.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max files to return (default 20)",
        },
        root: {
          type: "string",
          description:
            "Project root (defaults to current project)",
        },
      },
    },
  },
  {
    name: "diff_changes",
    description: "Search code scoped to git changes. Omit ref for uncommitted changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ref: { type: "string", description: "Git ref to diff against (e.g. main, HEAD~5)" },
        query: { type: "string", description: "Semantic search within changed files" },
        limit: { type: "number", description: "Max results (default 10)" },
        role: { type: "string", description: "Filter by role: ORCHESTRATION, DEFINITION, IMPLEMENTATION" },
      },
    },
  },
  {
    name: "find_tests",
    description: "Find tests that exercise a symbol or file via reverse call graph.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: { type: "string", description: "Symbol name or file path" },
        depth: { type: "number", description: "Caller traversal depth 1-3 (default 1)" },
      },
      required: ["target"],
    },
  },
  {
    name: "impact_analysis",
    description: "Change impact: dependents and affected tests for a symbol or file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: { type: "string", description: "Symbol name or file path" },
        depth: { type: "number", description: "Caller traversal depth 1-3 (default 1)" },
      },
      required: ["target"],
    },
  },
  {
    name: "find_similar",
    description: "Find semantically similar code using vector similarity.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: { type: "string", description: "Symbol name or file path" },
        limit: { type: "number", description: "Max results (default 5)" },
        threshold: { type: "number", description: "Min similarity 0-1 (default 0)" },
      },
      required: ["target"],
    },
  },
  {
    name: "build_context",
    description: "Token-budgeted topic summary (search + skeleton + extract).",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: { type: "string", description: "Natural language topic or directory path" },
        budget: { type: "number", description: "Max tokens (default 4000)" },
        limit: { type: "number", description: "Search result limit (default 10)" },
      },
      required: ["topic"],
    },
  },
  {
    name: "investigate",
    description: "Agentic codebase Q&A: a local LLM answers questions using search, trace, peek, impact, and related tools. Requires LLM to be enabled (gmax llm on).",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "Natural language question about the codebase" },
        max_rounds: { type: "number", description: "Max tool-call rounds (default 10)" },
      },
      required: ["question"],
    },
  },
  {
    name: "review_commit",
    description: "Review a git commit for bugs, breaking changes, and security issues using local LLM + codebase context. Returns structured findings. Requires LLM to be enabled (gmax llm on).",
    inputSchema: {
      type: "object" as const,
      properties: {
        commit: { type: "string", description: "Git ref to review (default: HEAD)" },
      },
      required: [],
    },
  },
  {
    name: "review_report",
    description: "Get the accumulated code review report for the current project. Returns findings from all reviewed commits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        json: { type: "boolean", description: "Return raw JSON instead of text (default: false)" },
      },
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v) => typeof v === "string");
  if (val && typeof (val as any).toArray === "function") {
    try {
      const arr = (val as any).toArray();
      return Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const mcp = new Command("mcp")
  .description("Start MCP server (stdio, auto-started by plugins)")
  .action(async (_optsArg, _cmd) => {
    process.title = "gmax-mcp";

    // --- Lifecycle ---

    let _vectorDb: VectorDB | null = null;
    let _searcher: Searcher | null = null;
    let _skeletonizer: Skeletonizer | null = null;
    let _indexReady = false;
    let _indexing = false;
    let _indexProgress = "";

    const cleanup = async () => {
      if (_vectorDb) {
        try {
          await _vectorDb.close();
        } catch {}
        _vectorDb = null;
        _searcher = null;
      }
    };

    const exit = async () => {
      await cleanup();
      process.exit(0);
    };

    process.on("SIGINT", exit);
    process.on("SIGTERM", exit);

    // MCP SDK doesn't handle stdin close — exit when the client disconnects
    process.stdin.on("end", exit);
    process.stdin.on("close", exit);

    process.on("unhandledRejection", (reason, promise) => {
      console.error(
        "[ERROR] Unhandled Rejection at:",
        promise,
        "reason:",
        reason,
      );
    });

    // MCP uses stdout — redirect all logs to stderr
    console.log = (...args: unknown[]) => {
      process.stderr.write(`[LOG] ${args.join(" ")}\n`);
    };
    console.error = (...args: unknown[]) => {
      process.stderr.write(`[ERROR] ${args.join(" ")}\n`);
    };
    console.debug = (..._args: unknown[]) => {};

    // --- Project context ---

    const projectRoot = findProjectRoot(process.cwd());
    const paths = ensureProjectPaths(projectRoot);

    // Propagate project root to worker processes
    process.env.GMAX_PROJECT_ROOT = paths.root;

    // Lazy resource accessors — all use centralized store
    function getVectorDb(): VectorDB {
      if (!_vectorDb) _vectorDb = new VectorDB(paths.lancedbDir);
      return _vectorDb;
    }

    function getSearcher(): Searcher {
      if (!_searcher) _searcher = new Searcher(getVectorDb());
      return _searcher;
    }

    async function getSkeletonizer(): Promise<Skeletonizer> {
      if (!_skeletonizer) {
        _skeletonizer = new Skeletonizer();
        await _skeletonizer.init();
      }
      return _skeletonizer;
    }

    // --- Index sync ---

    let _indexChildPid: number | null = null;

    function isIndexProcessRunning(): boolean {
      if (!_indexChildPid) return false;
      try {
        process.kill(_indexChildPid, 0);
        return true;
      } catch {
        return false;
      }
    }

    async function ensureIndexReady(): Promise<void> {
      if (_indexReady) return;

      // Check if a previously spawned index process finished
      if (_indexing && !isIndexProcessRunning()) {
        _indexing = false;
        _indexProgress = "";
        _indexChildPid = null;
      }

      // Check project registry — more reliable than querying the DB.
      // Avoids false negatives from lock contention and cascade re-indexing.
      const projects = listProjects();
      const isRegistered = projects.some((p) => p.root === projectRoot);

      if (isRegistered) {
        _indexReady = true;
        return;
      }

      // Truly first-time: no registry entry at all
      if (_indexing) return;

      _indexing = true;
      _indexProgress = "starting...";
      console.log("[MCP] First-time setup for this project...");

      const child = spawn(
        process.argv[0],
        [process.argv[1], "add", projectRoot],
        { detached: true, stdio: "ignore" },
      );
      _indexChildPid = child.pid ?? null;
      child.unref();
      _indexProgress = `PID ${_indexChildPid}`;

      child.on("exit", (code) => {
        _indexing = false;
        _indexProgress = "";
        _indexChildPid = null;
        if (code === 0) {
          _indexReady = true;
          console.log("[MCP] First-time setup complete.");
        } else {
          console.error(
            `[MCP] Indexing failed (exit code: ${code})`,
          );
        }
      });
    }

    // --- Background watcher ---

    async function ensureWatcher(): Promise<void> {
      try {
        const result = await launchWatcher(projectRoot);
        if (result.ok && !result.reused) {
          console.log(`[MCP] Started background watcher for ${projectRoot} (PID: ${result.pid})`);
        }
      } catch (err) {
        console.error("[MCP] Watcher startup failed:", err);
      }
    }

    // --- Tool handlers ---

    async function handleSemanticSearch(
      args: Record<string, unknown>,
      isSearchAll = false,
    ): Promise<ToolResult> {
      const query = String(args.query || "");
      if (!query) return err("Missing required parameter: query");
      const searchAll = isSearchAll || args.scope === "all";

      const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 50);

      ensureWatcher();

      if (_indexing) {
        return ok(
          `Indexing in progress (${_indexProgress}). Results may be incomplete or empty — try again shortly.`,
        );
      }

      try {
        const searcher = getSearcher();

        // Determine path prefix and display root for relative paths
        let pathPrefix: string | undefined;
        let displayRoot = projectRoot;

        if (!searchAll) {
          const searchRoot =
            typeof args.root === "string"
              ? path.resolve(args.root)
              : path.resolve(projectRoot);

          if (typeof args.root === "string" && !fs.existsSync(searchRoot)) {
            return err(`Directory not found: ${args.root}`);
          }

          displayRoot = searchRoot;
          pathPrefix = searchRoot.endsWith("/")
            ? searchRoot
            : `${searchRoot}/`;

          if (typeof args.path === "string") {
            pathPrefix = path.join(searchRoot, args.path);
            if (!pathPrefix.endsWith("/")) pathPrefix += "/";
          }
        }

        const filters: Record<string, string> = {};
        if (typeof args.file === "string" && args.file) {
          filters.file = args.file;
        }
        if (typeof args.exclude === "string" && args.exclude) {
          filters.exclude = args.exclude;
        }
        if (typeof args.language === "string" && args.language) {
          filters.language = args.language;
        }
        if (typeof args.role === "string" && args.role) {
          filters.role = args.role;
        }
        if (searchAll) {
          const allProjects = listProjects();
          if (typeof args.projects === "string" && args.projects) {
            const names = args.projects
              .split(",")
              .map((s: string) => s.trim());
            const roots = names
              .map(
                (n: string) => allProjects.find((p) => p.name === n)?.root,
              )
              .filter(Boolean);
            if (roots.length > 0) {
              filters.project_roots = roots.join(",");
            }
          }
          if (
            typeof args.exclude_projects === "string" &&
            args.exclude_projects
          ) {
            const names = args.exclude_projects
              .split(",")
              .map((s: string) => s.trim());
            const roots = names
              .map(
                (n: string) => allProjects.find((p) => p.name === n)?.root,
              )
              .filter(Boolean);
            if (roots.length > 0) {
              filters.exclude_project_roots = roots.join(",");
            }
          }
        }

        const result = await searcher.search(
          query,
          limit,
          { rerank: true },
          Object.keys(filters).length > 0 ? filters : undefined,
          pathPrefix,
        );

        if (!result.data || result.data.length === 0) {
          return ok(
            "No matches found. Try broadening your query, using fewer keywords, or check `gmax status` to verify the project is indexed.",
          );
        }

        const minScore =
          typeof args.min_score === "number" ? args.min_score : 0;
        const maxPerFile =
          typeof args.max_per_file === "number" ? args.max_per_file : 0;
        const detail =
          typeof args.detail === "string" ? args.detail : "pointer";
        const includeImports = Boolean(args.include_imports);
        const importCache = new Map<string, string>();

        let results = result.data.map((r: any) => {
          const absPath = r.path ?? r.metadata?.path ?? "";
          const relPath = absPath.startsWith(displayRoot)
            ? absPath.slice(displayRoot.length + 1)
            : absPath;
          const startLine =
            r.startLine ?? r.generated_metadata?.start_line ?? 0;
          const endLine = r.endLine ?? r.generated_metadata?.end_line ?? 0;
          const defs = toStringArray(
            r.definedSymbols ?? r.defined_symbols,
          );
          const refs = toStringArray(
            r.referenced_symbols ?? r.referencedSymbols,
          );
          const symbol = defs[0] || "(anonymous)";
          const role = (r.role ?? "IMPL").slice(0, 4).toUpperCase();
          const exported = r.is_exported ? "exported " : "";
          const complexity =
            typeof r.complexity === "number" && r.complexity > 0
              ? ` C:${Math.round(r.complexity)}`
              : "";
          const parentStr = r.parent_symbol
            ? `parent:${r.parent_symbol} `
            : "";
          const callsStr =
            refs.length > 0
              ? `calls:${refs.slice(0, 8).join(",")}`
              : "";

          const line1 = `${symbol} [${exported}${role}${complexity}] ${relPath}:${startLine + 1}-${endLine + 1}`;
          const summaryStr =
            r.summary ? `  ${r.summary}` : "";
          const line2 =
            parentStr || callsStr
              ? `  ${parentStr}${callsStr}`
              : "";

          let snippet = "";
          const contextN =
            typeof args.context_lines === "number"
              ? Math.min(Math.max(args.context_lines, 0), 20)
              : 0;
          if (detail === "code" || detail === "full") {
            if (contextN > 0 && absPath) {
              // Read surrounding context from file
              try {
                const fileContent = fs.readFileSync(absPath, "utf-8");
                const fileLines = fileContent.split("\n");
                const ctxStart = Math.max(0, startLine - contextN);
                const ctxEnd = Math.min(
                  fileLines.length,
                  endLine + 1 + contextN,
                );
                snippet =
                  "\n" +
                  fileLines
                    .slice(ctxStart, ctxEnd)
                    .map(
                      (l: string, i: number) =>
                        `${ctxStart + i + 1}│${l}`,
                    )
                    .join("\n");
              } catch {
                // Fall through to chunk content
              }
            }
            if (!snippet) {
              const raw =
                typeof r.content === "string"
                  ? r.content
                  : typeof r.text === "string"
                    ? r.text
                    : "";
              const allLines = raw.split("\n");
              const linesToShow =
                detail === "full" ? allLines : allLines.slice(0, 4);
              snippet =
                "\n" +
                linesToShow
                  .map(
                    (l: string, i: number) =>
                      `${startLine + i + 1}│${l}`,
                  )
                  .join("\n");
            }
          }

          let text =
            line1 +
            (summaryStr ? `\n${summaryStr}` : "") +
            (line2 ? `\n${line2}` : "") +
            snippet;

          if (includeImports && absPath) {
            if (!importCache.has(absPath)) {
              importCache.set(absPath, extractImports(absPath));
            }
            const imports = importCache.get(absPath)!;
            if (imports) {
              text = `imports:\n${imports}\n\n${text}`;
            }
          }

          return {
            absPath,
            text,
            score: typeof r.score === "number" ? r.score : 0,
            symbols: defs,
          };
        });

        if (minScore > 0) {
          results = results.filter((r) => r.score >= minScore);
        }

        if (maxPerFile > 0) {
          const counts = new Map<string, number>();
          results = results.filter((r) => {
            const count = counts.get(r.absPath) || 0;
            if (count >= maxPerFile) return false;
            counts.set(r.absPath, count + 1);
            return true;
          });
        }

        const namePattern =
          typeof args.name_pattern === "string"
            ? args.name_pattern
            : "";
        if (namePattern) {
          try {
            const regex = new RegExp(namePattern, "i");
            results = results.filter((r) =>
              r.symbols.some((s: string) => regex.test(s)),
            );
          } catch {
            // Invalid regex — skip filter
          }
        }

        let output = results.map((r) => r.text).join("\n\n");

        // Symbol mode: append call graph
        const mode =
          typeof args.mode === "string" ? args.mode : "default";
        if (mode === "symbol" && !searchAll) {
          try {
            const db = getVectorDb();
            const builder = new GraphBuilder(db);
            const graph = await builder.buildGraph(query);

            if (graph.center) {
              const traceLines: string[] = ["", "--- Call graph ---"];
              const centerRel = graph.center.file.startsWith(projectRoot)
                ? graph.center.file.slice(projectRoot.length + 1)
                : graph.center.file;
              traceLines.push(
                `${graph.center.symbol} [${graph.center.role}] ${centerRel}:${graph.center.line + 1}`,
              );

              if (graph.callers.length > 0) {
                traceLines.push("Callers:");
                for (const caller of graph.callers) {
                  const rel = caller.file.startsWith(projectRoot)
                    ? caller.file.slice(projectRoot.length + 1)
                    : caller.file;
                  traceLines.push(
                    `  <- ${caller.symbol} ${rel}:${caller.line + 1}`,
                  );
                }
              }

              if (graph.callees.length > 0) {
                traceLines.push("Calls:");
                for (const callee of graph.callees.slice(0, 15)) {
                  if (callee.file) {
                    const rel = callee.file.startsWith(projectRoot)
                      ? callee.file.slice(projectRoot.length + 1)
                      : callee.file;
                    traceLines.push(
                      `  -> ${callee.symbol} ${rel}:${callee.line + 1}`,
                    );
                  } else {
                    traceLines.push(
                      `  -> ${callee.symbol} (not indexed)`,
                    );
                  }
                }
              }

              output += `\n${traceLines.join("\n")}`;
            }
          } catch {
            // Trace failed — return search results without trace
          }
        }

        if (result.warnings?.length) {
          return ok(`${result.warnings.join("\n")}\n\n${output}`);
        }
        return ok(output);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Search failed: ${msg}`);
      }
    }

    async function handleCodeSkeleton(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const target = String(args.target || "");
      if (!target) return err("Missing required parameter: target");

      const fileLimit = Math.min(
        Math.max(Number(args.limit) || 10, 1),
        20,
      );

      // Determine targets: comma-separated, directory, or single file
      let targets: string[];

      if (target.includes(",")) {
        targets = target
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      } else {
        const absPath = path.resolve(projectRoot, target);
        if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
          const entries = fs.readdirSync(absPath, { withFileTypes: true });
          targets = entries
            .filter(
              (e) =>
                e.isFile() &&
                isIndexableFile(path.join(absPath, e.name)),
            )
            .map((e) =>
              path.relative(projectRoot, path.join(absPath, e.name)),
            )
            .slice(0, fileLimit);
          if (targets.length === 0) {
            return err(`No indexable files found in ${target}`);
          }
        } else {
          targets = [target];
        }
      }

      const fmt =
        typeof args.format === "string" ? args.format : "text";

      // Generate skeletons for all targets
      const parts: string[] = [];
      const jsonFiles: Array<{
        file: string;
        language: string;
        tokenEstimate: number;
        symbols: Array<{
          name: string;
          line: number;
          signature: string;
          type: string;
          exported: boolean;
        }>;
      }> = [];
      const skel = await getSkeletonizer();

      for (const t of targets) {
        const absPath = path.resolve(projectRoot, t);

        if (!fs.existsSync(absPath)) {
          if (fmt !== "json")
            parts.push(`// ${t} — file not found`);
          continue;
        }

        // Read source for line annotations
        let sourceContent = "";
        try {
          sourceContent = fs.readFileSync(absPath, "utf-8");
        } catch {}

        let skeleton = "";
        let language = "";
        let tokenEstimate = 0;

        // Try cached skeleton first
        try {
          const db = getVectorDb();
          const cached = await getStoredSkeleton(db, absPath);
          if (cached) {
            skeleton = cached;
            tokenEstimate = Math.ceil(cached.length / 4);
          }
        } catch {}

        // Generate live if no cache
        if (!skeleton) {
          try {
            const content =
              sourceContent || fs.readFileSync(absPath, "utf-8");
            const result = await skel.skeletonizeFile(absPath, content);
            if (result.success) {
              skeleton = result.skeleton;
              tokenEstimate = result.tokenEstimate;
              language = result.language;
            } else {
              if (fmt !== "json")
                parts.push(`// ${t} — skeleton failed: ${result.error}`);
              continue;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (fmt !== "json")
              parts.push(`// ${t} — error: ${msg}`);
            continue;
          }
        }

        if (fmt === "json") {
          // Extract structured symbols from annotated skeleton
          const annotated = sourceContent
            ? annotateSkeletonLines(skeleton, sourceContent)
            : skeleton;
          const symbols = extractSymbolsFromSkeleton(annotated);

          jsonFiles.push({
            file: t,
            language: language || path.extname(t).slice(1),
            tokenEstimate,
            symbols,
          });
        } else {
          const annotated = sourceContent
            ? annotateSkeletonLines(skeleton, sourceContent)
            : skeleton;
          parts.push(
            `// ${t} (~${tokenEstimate} tokens)\n\n${annotated}`,
          );
        }
      }

      if (fmt === "json") {
        const output =
          jsonFiles.length === 1
            ? jsonFiles[0]
            : { files: jsonFiles };
        return ok(JSON.stringify(output, null, 2));
      }
      return ok(parts.join("\n\n---\n\n"));
    }

    async function handleTraceCalls(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const symbol = String(args.symbol || "");
      if (!symbol) return err("Missing required parameter: symbol");

      if (_indexing) {
        return ok(
          `Indexing in progress (${_indexProgress}). trace_calls requires a complete index — try again shortly.`,
        );
      }

      try {
        const db = getVectorDb();
        const builder = new GraphBuilder(db);
        const depth = Math.min(
          Math.max(Number(args.depth) || 1, 1),
          3,
        );
        const graph = await builder.buildGraphMultiHop(symbol, depth);

        if (!graph.center) {
          return ok(
            `Symbol '${symbol}' not found in the index. Check \`gmax status\` to see which projects are indexed, or try \`gmax search ${symbol}\` to find similar symbols.`,
          );
        }

        const lines: string[] = [];

        // Center
        lines.push(
          `${graph.center.symbol} [${graph.center.role}] ${graph.center.file}:${graph.center.line + 1}`,
        );

        // Importers
        if (graph.importers.length > 0) {
          // Filter out the file where the symbol is defined
          const centerFile = graph.center.file;
          const filteredImporters = graph.importers.filter(
            (p) => p !== centerFile,
          );
          if (filteredImporters.length > 0) {
            lines.push("Imported by:");
            for (const imp of filteredImporters.slice(0, 10)) {
              const rel = imp.startsWith(projectRoot)
                ? imp.slice(projectRoot.length + 1)
                : imp;
              lines.push(`  ${rel}`);
            }
          }
        }

        // Callers (recursive tree)
        function formatCallerTree(
          trees: CallerTree[],
          indent: number,
        ): void {
          for (const t of trees) {
            const rel = t.node.file.startsWith(projectRoot)
              ? t.node.file.slice(projectRoot.length + 1)
              : t.node.file;
            const pad = "  ".repeat(indent);
            lines.push(
              `${pad}<- ${t.node.symbol} ${rel}:${t.node.line + 1}`,
            );
            formatCallerTree(t.callers, indent + 1);
          }
        }

        if (graph.callerTree.length > 0) {
          lines.push("Callers:");
          formatCallerTree(graph.callerTree, 1);
        } else {
          lines.push("Callers: none");
        }

        // Callees with file paths
        if (graph.callees.length > 0) {
          lines.push("Calls:");
          for (const callee of graph.callees.slice(0, 15)) {
            if (callee.file) {
              const rel = callee.file.startsWith(projectRoot)
                ? callee.file.slice(projectRoot.length + 1)
                : callee.file;
              lines.push(`  -> ${callee.symbol} ${rel}:${callee.line + 1}`);
            } else {
              lines.push(`  -> ${callee.symbol} (not indexed)`);
            }
          }
          if (graph.callees.length > 15) {
            lines.push(`  (+${graph.callees.length - 15} more)`);
          }
        } else {
          lines.push("Calls: none");
        }

        return ok(lines.join("\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Trace failed: ${msg}`);
      }
    }

    async function handleExtractSymbol(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const symbol = String(args.symbol || "");
      if (!symbol) return err("Missing required parameter: symbol");

      try {
        const root =
          typeof args.root === "string" && args.root
            ? args.root
            : projectRoot;
        const db = getVectorDb();
        const table = await db.ensureTable();
        const prefix = root.endsWith("/") ? root : `${root}/`;

        const rows = await table
          .query()
          .select([
            "path",
            "start_line",
            "end_line",
            "role",
            "is_exported",
            "defined_symbols",
          ])
          .where(
            `array_contains(defined_symbols, '${escapeSqlString(symbol)}') AND path LIKE '${escapeSqlString(prefix)}%'`,
          )
          .limit(10)
          .toArray();

        if (rows.length === 0) {
          return ok(
            `Symbol '${symbol}' not found in the index. Check \`gmax status\` to see which projects are indexed, or try \`gmax search ${symbol}\` to find similar symbols.`,
          );
        }

        // Pick best match: prefer exact first-defined, then highest role
        const ROLE_PRI: Record<string, number> = {
          ORCHESTRATION: 3,
          DEFINITION: 2,
          IMPLEMENTATION: 1,
        };
        const sorted = rows.sort((a: any, b: any) => {
          const aDefs = Array.isArray(a.defined_symbols)
            ? a.defined_symbols
            : [];
          const bDefs = Array.isArray(b.defined_symbols)
            ? b.defined_symbols
            : [];
          const aFirst = aDefs[0] === symbol ? 1 : 0;
          const bFirst = bDefs[0] === symbol ? 1 : 0;
          if (bFirst !== aFirst) return bFirst - aFirst;
          return (
            (ROLE_PRI[String(b.role)] || 0) - (ROLE_PRI[String(a.role)] || 0)
          );
        });

        const best = sorted[0] as any;
        const filePath = String(best.path);
        const startLine = Number(best.start_line || 0);
        const endLine = Number(best.end_line || 0);
        const role = String(best.role || "IMPLEMENTATION");
        const exported = Boolean(best.is_exported);

        const fs = await import("node:fs");
        const content = fs.readFileSync(filePath, "utf-8");
        const allLines = content.split("\n");
        const body = allLines
          .slice(startLine, Math.min(endLine + 1, allLines.length))
          .join("\n");

        const relPath = filePath.startsWith(root)
          ? filePath.slice(root.length + 1)
          : filePath;
        const exportedStr = exported ? ", exported" : "";

        const parts: string[] = [];
        if (args.include_imports) {
          const { extractImportsFromContent } = await import(
            "../lib/utils/import-extractor"
          );
          const imports = extractImportsFromContent(content);
          if (imports) parts.push(imports, "");
        }
        parts.push(
          `// ${relPath}:${startLine + 1}-${endLine + 1} [${role}${exportedStr}]`,
        );
        parts.push(body);

        // Note other definitions
        const others = sorted.slice(1, 4);
        if (others.length > 0) {
          const otherLocs = others
            .map((r: any) => {
              const p = String(r.path);
              const rel = p.startsWith(root) ? p.slice(root.length + 1) : p;
              return `${rel}:${Number(r.start_line || 0) + 1}`;
            })
            .join(", ");
          parts.push("", `Also defined in: ${otherLocs}`);
        }

        return ok(parts.join("\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Extract failed: ${msg}`);
      }
    }

    async function handlePeekSymbol(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const symbol = String(args.symbol || "");
      if (!symbol) return err("Missing required parameter: symbol");

      try {
        const root =
          typeof args.root === "string" && args.root
            ? args.root
            : projectRoot;
        const depth = Math.min(
          Math.max(Number(args.depth || 1), 1),
          3,
        );

        const db = getVectorDb();
        const { GraphBuilder } = await import("../lib/graph/graph-builder");
        const builder = new GraphBuilder(db, root);
        const graph = await builder.buildGraph(symbol);

        if (!graph.center) {
          return ok(
            `Symbol '${symbol}' not found in the index. Check \`gmax status\` to see which projects are indexed, or try \`gmax search ${symbol}\` to find similar symbols.`,
          );
        }

        const center = graph.center;
        const rel = (p: string) =>
          p.startsWith(root) ? p.slice(root.length + 1) : p;

        // Get chunk metadata for is_exported and end_line
        const table = await db.ensureTable();
        const prefix = root.endsWith("/") ? root : `${root}/`;
        const metaRows = await table
          .query()
          .select(["is_exported", "start_line", "end_line"])
          .where(
            `array_contains(defined_symbols, '${escapeSqlString(symbol)}') AND path LIKE '${escapeSqlString(prefix)}%'`,
          )
          .limit(1)
          .toArray();
        const exported =
          metaRows.length > 0 && Boolean((metaRows[0] as any).is_exported);
        const startLine =
          metaRows.length > 0
            ? Number((metaRows[0] as any).start_line || 0)
            : center.line;
        const endLine =
          metaRows.length > 0
            ? Number((metaRows[0] as any).end_line || 0)
            : center.line;

        // Get signature from source
        const fs = await import("node:fs");
        let sigText = "(source not available)";
        let bodyLines = 0;
        try {
          const content = fs.readFileSync(center.file, "utf-8");
          const lines = content.split("\n");
          const chunk = lines.slice(startLine, endLine + 1);
          bodyLines = chunk.length;
          const sigLines: string[] = [];
          for (const line of chunk) {
            sigLines.push(line);
            if (line.includes("{") || line.includes("=>")) break;
          }
          sigText = sigLines.join("\n").trim();
        } catch {}

        // Get callers
        let callerList: Array<{ symbol: string; file: string; line: number }>;
        if (depth > 1) {
          const multiHop = await builder.buildGraphMultiHop(symbol, depth);
          const flat: Array<{
            symbol: string;
            file: string;
            line: number;
          }> = [];
          function walkCallers(tree: any[]) {
            for (const t of tree) {
              flat.push({
                symbol: t.node.symbol,
                file: t.node.file,
                line: t.node.line,
              });
              walkCallers(t.callers);
            }
          }
          walkCallers(multiHop.callerTree);
          callerList = flat;
        } else {
          callerList = graph.callers;
        }

        const exportedStr = exported ? ", exported" : "";
        const parts: string[] = [];
        parts.push(
          `${center.symbol}  ${rel(center.file)}:${center.line + 1}  [${center.role}${exportedStr}]`,
        );
        parts.push("");
        parts.push(`  ${sigText}`);
        if (bodyLines > 3) {
          parts.push(`    // ... (${bodyLines} lines total)`);
        }
        parts.push("");

        // Callers
        const maxCallers = 5;
        if (callerList.length > 0) {
          parts.push(`callers (${callerList.length}):`);
          for (const c of callerList.slice(0, maxCallers)) {
            const loc = c.file
              ? `${rel(c.file)}:${c.line + 1}`
              : "(not indexed)";
            parts.push(`  <- ${c.symbol}  ${loc}`);
          }
          if (callerList.length > maxCallers) {
            parts.push(
              `  ... and ${callerList.length - maxCallers} more`,
            );
          }
        } else {
          parts.push("No known callers.");
        }
        parts.push("");

        // Callees
        const maxCallees = 8;
        if (graph.callees.length > 0) {
          parts.push(`callees (${graph.callees.length}):`);
          for (const c of graph.callees.slice(0, maxCallees)) {
            const loc = c.file
              ? `${rel(c.file)}:${c.line + 1}`
              : "(not indexed)";
            parts.push(`  -> ${c.symbol}  ${loc}`);
          }
          if (graph.callees.length > maxCallees) {
            parts.push(
              `  ... and ${graph.callees.length - maxCallees} more`,
            );
          }
        } else {
          parts.push("No known callees.");
        }

        return ok(parts.join("\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Peek failed: ${msg}`);
      }
    }

    async function handleListSymbols(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const pattern =
        typeof args.pattern === "string" ? args.pattern : undefined;
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const pathPrefix = typeof args.path === "string" ? args.path : undefined;

      if (_indexing) {
        return ok(
          `Indexing in progress (${_indexProgress}). list_symbols requires a complete index — try again shortly.`,
        );
      }

      try {
        const db = getVectorDb();
        const table = await db.ensureTable();

        let query = table
          .query()
          .select(["defined_symbols", "path", "start_line", "role", "is_exported"])
          .where("array_length(defined_symbols) > 0")
          .limit(pattern ? 10000 : Math.max(limit * 50, 2000));

        if (pathPrefix) {
          // Support both absolute and relative path prefixes
          const absPrefix = path.isAbsolute(pathPrefix)
            ? pathPrefix
            : path.resolve(projectRoot, pathPrefix);
          query = query.where(
            `path LIKE '${escapeSqlString(normalizePath(absPrefix))}%'`,
          );
        }

        const rows = await query.toArray();

        const map = new Map<
          string,
          { symbol: string; count: number; path: string; line: number; role: string; exported: boolean }
        >();
        for (const row of rows) {
          const defs = toStringArray((row as any).defined_symbols);
          const rowPath = String((row as any).path || "");
          const line = Number((row as any).start_line || 0);
          const role = String((row as any).role || "");
          const exported = Boolean((row as any).is_exported);
          for (const sym of defs) {
            if (pattern && !sym.toLowerCase().includes(pattern.toLowerCase())) {
              continue;
            }
            const existing = map.get(sym);
            if (existing) {
              existing.count += 1;
            } else {
              map.set(sym, {
                symbol: sym,
                count: 1,
                path: rowPath,
                line: Math.max(1, line + 1),
                role,
                exported,
              });
            }
          }
        }

        const entries = Array.from(map.values())
          .sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return a.symbol.localeCompare(b.symbol);
          })
          .slice(0, limit);

        if (entries.length === 0) {
          return ok(
            "No symbols found. Run `gmax status` to verify the project is indexed, or `gmax index` to rebuild.",
          );
        }

        const lines = entries.map((e) => {
          const rel = e.path.startsWith(projectRoot)
            ? e.path.slice(projectRoot.length + 1)
            : e.path;
          const roleTag = e.role ? ` [${e.role.slice(0, 4)}]` : "";
          const expTag = e.exported ? " exported" : "";
          return `${e.symbol}${roleTag}${expTag}\t${rel}:${e.line}`;
        });
        return ok(lines.join("\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Symbol listing failed: ${msg}`);
      }
    }

    async function handleIndexStatus(): Promise<ToolResult> {
      try {
        const config = readIndexConfig(PATHS.configPath);
        const globalConfig = readGlobalConfig();
        const projects = listProjects();

        const db = getVectorDb();
        const stats = await db.getStats();
        const fileCount = await db.getDistinctFileCount();

        // Watcher status
        const watcher = getWatcherCoveringPath(projectRoot);
        let watcherLine = "Watcher: not running";
        if (watcher) {
          const status = watcher.status ?? "unknown";
          const root = path.basename(watcher.projectRoot);
          const reindex = watcher.lastReindex
            ? `last reindex: ${Math.round((Date.now() - watcher.lastReindex) / 60000)}m ago`
            : "";
          watcherLine = `Watcher: ${status} (${root}/)${reindex ? ` ${reindex}` : ""}`;
          if (status === "syncing") {
            watcherLine += " — search results may be incomplete";
          }
        }

        const indexingLine = _indexing
          ? `Indexing: in progress (${_indexProgress})`
          : "";

        const lines = [
          `Index: ~/.gmax/lancedb (${stats.chunks} chunks, ${fileCount} files)`,
          `Model: ${globalConfig.embedMode === "gpu" ? (MODEL_TIERS[globalConfig.modelTier]?.mlxModel ?? config?.embedModel ?? "unknown") : (config?.embedModel ?? "unknown")} (${config?.vectorDim ?? "?"}d, ${globalConfig.embedMode})`,
          config?.indexedAt
            ? `Last indexed: ${config.indexedAt}`
            : "",
          watcherLine,
          indexingLine,
          "",
          "Indexed directories:",
          ...(await Promise.all(
            projects.map(async (p) => {
              const prefix = p.root.endsWith("/") ? p.root : `${p.root}/`;
              try {
                const table = await db.ensureTable();
                const rows = await table
                  .query()
                  .select(["id"])
                  .where(`path LIKE '${escapeSqlString(prefix)}%'`)
                  .limit(100000)
                  .toArray();
                return `  ${p.name}\t${p.root}\t${p.lastIndexed ?? "unknown"}\t(${rows.length} chunks)`;
              } catch {
                return `  ${p.name}\t${p.root}\t${p.lastIndexed ?? "unknown"}`;
              }
            }),
          )),
        ].filter(Boolean);
        return ok(lines.join("\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Status check failed: ${msg}`);
      }
    }

    async function handleSummarizeDirectory(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      const dir =
        typeof args.path === "string"
          ? path.resolve(args.path)
          : projectRoot;
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const limit = Math.min(
        Math.max(Number(args.limit) || 200, 1),
        5000,
      );

      try {
        const db = getVectorDb();
        const { summarized, remaining } = await generateSummaries(
          db,
          prefix,
          (done, total) => {
            console.log(`[summarize] ${done}/${total} chunks`);
          },
          limit,
        );

        if (summarized === 0) {
          return ok(
            "No chunks to summarize (all have summaries or summarizer unavailable)",
          );
        }
        const remainMsg = remaining > 0
          ? ` (${remaining}+ remaining — run again to continue)`
          : "";
        return ok(
          `Summarized ${summarized} chunks in ${path.basename(dir)}/${remainMsg}`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Summarization failed: ${msg}`);
      }
    }

    async function handleSummarizeProject(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      const root =
        typeof args.root === "string"
          ? path.resolve(args.root)
          : projectRoot;
      const prefix = root.endsWith("/") ? root : `${root}/`;
      const projectName = path.basename(root);

      try {
        const db = getVectorDb();
        const table = await db.ensureTable();

        const rows = await table
          .query()
          .select([
            "path",
            "role",
            "is_exported",
            "complexity",
            "defined_symbols",
            "referenced_symbols",
          ])
          .where(`path LIKE '${escapeSqlString(prefix)}%'`)
          .limit(200000)
          .toArray();

        if (rows.length === 0) {
          return ok(
            `No indexed data found for ${root}. Run: gmax index --path ${root}`,
          );
        }

        const files = new Set<string>();
        const extCounts = new Map<string, number>();
        const dirCounts = new Map<
          string,
          { files: Set<string>; chunks: number }
        >();
        const roleCounts = new Map<string, number>();
        const symbolRefs = new Map<string, number>();
        const entryPoints: Array<{ symbol: string; path: string }> = [];

        for (const row of rows) {
          const p = String((row as any).path || "");
          const role = String((row as any).role || "IMPLEMENTATION");
          const exported = Boolean((row as any).is_exported);
          const complexity = Number((row as any).complexity || 0);
          const defs = toStringArray((row as any).defined_symbols);
          const refs = toStringArray((row as any).referenced_symbols);

          files.add(p);

          const ext =
            path.extname(p).toLowerCase() || path.basename(p);
          extCounts.set(ext, (extCounts.get(ext) || 0) + 1);

          const rel = p.startsWith(prefix)
            ? p.slice(prefix.length)
            : p;
          const parts = rel.split("/");
          const dir =
            parts.length > 2
              ? `${parts.slice(0, 2).join("/")}/`
              : parts.length > 1
                ? `${parts[0]}/`
                : "(root)";
          if (!dirCounts.has(dir)) {
            dirCounts.set(dir, { files: new Set(), chunks: 0 });
          }
          const dc = dirCounts.get(dir)!;
          dc.files.add(p);
          dc.chunks++;

          roleCounts.set(role, (roleCounts.get(role) || 0) + 1);

          for (const ref of refs) {
            symbolRefs.set(ref, (symbolRefs.get(ref) || 0) + 1);
          }

          if (
            exported &&
            role === "ORCHESTRATION" &&
            complexity >= 5 &&
            defs.length > 0
          ) {
            const relPath = p.startsWith(prefix)
              ? p.slice(prefix.length)
              : p;
            entryPoints.push({ symbol: defs[0], path: relPath });
          }
        }

        const lines: string[] = [];
        const projects = listProjects();
        const proj = projects.find((p) => p.root === root);
        lines.push(`Project: ${projectName} (${root})`);
        lines.push(
          `Last indexed: ${proj?.lastIndexed ?? "unknown"} • ${rows.length} chunks • ${files.size} files`,
        );
        lines.push("");

        const extEntries = Array.from(extCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8);
        const langLine = extEntries
          .map(
            ([ext, count]) =>
              `${ext} (${Math.round((count / rows.length) * 100)}%)`,
          )
          .join(", ");
        lines.push(`Languages: ${langLine}`);
        lines.push("");

        lines.push("Directory structure:");
        const dirEntries = Array.from(dirCounts.entries())
          .sort((a, b) => b[1].chunks - a[1].chunks)
          .slice(0, 12);
        for (const [dir, data] of dirEntries) {
          lines.push(
            `  ${dir.padEnd(25)} (${data.files.size} files, ${data.chunks} chunks)`,
          );
        }
        lines.push("");

        const roleEntries = Array.from(roleCounts.entries()).sort(
          (a, b) => b[1] - a[1],
        );
        const roleLine = roleEntries
          .map(
            ([role, count]) =>
              `${Math.round((count / rows.length) * 100)}% ${role}`,
          )
          .join(", ");
        lines.push(`Roles: ${roleLine}`);
        lines.push("");

        const topSymbols = Array.from(symbolRefs.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8);
        if (topSymbols.length > 0) {
          lines.push("Key symbols (by reference count):");
          for (const [sym, count] of topSymbols) {
            lines.push(
              `  ${sym.padEnd(25)} (referenced ${count}x)`,
            );
          }
          lines.push("");
        }

        if (entryPoints.length > 0) {
          lines.push("Entry points (exported orchestration):");
          for (const ep of entryPoints.slice(0, 10)) {
            lines.push(`  ${ep.symbol.padEnd(25)} ${ep.path}`);
          }
        }

        return ok(lines.join("\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Project summary failed: ${msg}`);
      }
    }

    async function handleRelatedFiles(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const file = String(args.file || "");
      if (!file) return err("Missing required parameter: file");

      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
      const absPath = path.resolve(projectRoot, file);

      try {
        const db = getVectorDb();
        const table = await db.ensureTable();

        const fileChunks = await table
          .query()
          .select(["defined_symbols", "referenced_symbols"])
          .where(`path = '${escapeSqlString(absPath)}'`)
          .toArray();

        if (fileChunks.length === 0) {
          return ok(
            `File not found in index: ${file}. Check that the path is relative to the project root. Run \`gmax status\` to see indexed projects.`,
          );
        }

        const definedHere = new Set<string>();
        const referencedHere = new Set<string>();
        for (const chunk of fileChunks) {
          for (const s of toStringArray((chunk as any).defined_symbols))
            definedHere.add(s);
          for (const s of toStringArray(
            (chunk as any).referenced_symbols,
          ))
            referencedHere.add(s);
        }

        // Dependencies: files that DEFINE symbols this file REFERENCES
        const depCounts = new Map<string, number>();
        for (const sym of referencedHere) {
          if (definedHere.has(sym)) continue;
          const rows = await table
            .query()
            .select(["path"])
            .where(
              `array_contains(defined_symbols, '${escapeSqlString(sym)}')`,
            )
            .limit(3)
            .toArray();
          for (const row of rows) {
            const p = String((row as any).path || "");
            if (p === absPath) continue;
            depCounts.set(p, (depCounts.get(p) || 0) + 1);
          }
        }

        // Dependents: files that REFERENCE symbols this file DEFINES
        const revCounts = new Map<string, number>();
        for (const sym of definedHere) {
          const rows = await table
            .query()
            .select(["path"])
            .where(
              `array_contains(referenced_symbols, '${escapeSqlString(sym)}')`,
            )
            .limit(20)
            .toArray();
          for (const row of rows) {
            const p = String((row as any).path || "");
            if (p === absPath) continue;
            revCounts.set(p, (revCounts.get(p) || 0) + 1);
          }
        }

        const lines: string[] = [];
        lines.push(`Related files for ${file}:\n`);

        const topDeps = Array.from(depCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit);
        if (topDeps.length > 0) {
          lines.push("Dependencies (files this imports/calls):");
          for (const [p, count] of topDeps) {
            const rel = p.startsWith(`${projectRoot}/`)
              ? p.slice(projectRoot.length + 1)
              : p;
            lines.push(
              `  ${rel.padEnd(40)} (${count} shared symbol${count > 1 ? "s" : ""})`,
            );
          }
        } else {
          lines.push("Dependencies: none found");
        }

        lines.push("");

        const topRevs = Array.from(revCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit);
        if (topRevs.length > 0) {
          lines.push("Dependents (files that call this):");
          for (const [p, count] of topRevs) {
            const rel = p.startsWith(`${projectRoot}/`)
              ? p.slice(projectRoot.length + 1)
              : p;
            lines.push(
              `  ${rel.padEnd(40)} (${count} shared symbol${count > 1 ? "s" : ""})`,
            );
          }
        } else {
          lines.push("Dependents: none found");
        }

        return ok(lines.join("\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Related files failed: ${msg}`);
      }
    }

    async function handleRecentChanges(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const limit = Math.min(
        Math.max(Number(args.limit) || 20, 1),
        50,
      );
      const root =
        typeof args.root === "string"
          ? path.resolve(args.root)
          : projectRoot;
      const prefix = root.endsWith("/") ? root : `${root}/`;

      try {
        const metaCache = new MetaCache(PATHS.lmdbPath);
        try {
          const files: Array<{ path: string; mtimeMs: number }> = [];
          for await (const {
            path: p,
            entry,
          } of metaCache.entries()) {
            if (p.startsWith(prefix)) {
              files.push({ path: p, mtimeMs: entry.mtimeMs });
            }
          }
          files.sort((a, b) => b.mtimeMs - a.mtimeMs);
          const top = files.slice(0, limit);

          if (top.length === 0) {
            return ok(
              `No indexed files found for ${root}. Run \`gmax add\` to register and index this project.`,
            );
          }

          const now = Date.now();
          const lines = [
            `Recent changes in ${path.basename(root)} (${top.length} most recent):\n`,
          ];
          for (const f of top) {
            const rel = f.path.startsWith(prefix)
              ? f.path.slice(prefix.length)
              : f.path;
            const ago = formatTimeAgo(now - f.mtimeMs);
            lines.push(`  ${ago.padEnd(10)} ${rel}`);
          }
          return ok(lines.join("\n"));
        } finally {
          await metaCache.close();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Recent changes failed: ${msg}`);
      }
    }

    // --- New command handlers (Phase 4) ---

    async function handleDiffChanges(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const { getChangedFiles } = await import("../lib/utils/git");
      const ref = typeof args.ref === "string" ? args.ref : undefined;
      const query = typeof args.query === "string" ? args.query : undefined;
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const role = typeof args.role === "string" ? args.role.toUpperCase() : undefined;

      try {
        const changedFiles = getChangedFiles(ref, projectRoot);
        if (changedFiles.length === 0) {
          return ok(ref ? `No changes found relative to ${ref}.` : "No uncommitted changes found.");
        }

        const rel = (p: string) =>
          p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;

        if (query) {
          const searcher = getSearcher();
          const response = await searcher.search(query, limit, { rerank: true }, {}, projectRoot);
          const changedSet = new Set(changedFiles);
          let filtered = response.data.filter((r: any) => changedSet.has(String(r.path || "")));
          if (role) filtered = filtered.filter((r: any) => String(r.role || "").toUpperCase().startsWith(role));
          if (filtered.length === 0) return ok("No indexed results found in changed files for that query.");
          const lines = filtered.slice(0, limit).map((r: any) => {
            const sym = toStringArray(r.defined_symbols)?.[0] ?? "";
            return `${rel(r.path)}:${Number(r.start_line ?? 0) + 1} ${sym} [${r.role || "IMPL"}]`;
          });
          return ok(lines.join("\n"));
        }

        const db = getVectorDb();
        const table = await db.ensureTable();
        const lines: string[] = [];
        for (const file of changedFiles) {
          const chunks = await table.query()
            .select(["defined_symbols", "role"])
            .where(`path = '${escapeSqlString(file)}'`)
            .limit(50).toArray();
          const symbols = chunks.flatMap((c: any) => toStringArray(c.defined_symbols));
          lines.push(symbols.length > 0
            ? `${rel(file)} (${symbols.slice(0, 5).join(", ")}${symbols.length > 5 ? "..." : ""})`
            : rel(file));
        }
        return ok(`${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}${ref ? ` (vs ${ref})` : ""}:\n${lines.join("\n")}`);
      } catch (e) {
        return err(`Diff failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    async function handleFindTests(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const target = String(args.target || "");
      if (!target) return err("Missing required parameter: target");
      const depth = Math.min(Math.max(Number(args.depth) || 1, 1), 3);

      try {
        const { resolveTargetSymbols, findTests } = await import("../lib/graph/impact");
        const db = getVectorDb();
        const { symbols } = await resolveTargetSymbols(target, db, projectRoot);
        if (symbols.length === 0) return ok(`No symbols found for: ${target}`);

        const tests = await findTests(symbols, db, projectRoot, depth);
        if (tests.length === 0) return ok(`No tests found for ${target}.`);

        const rel = (p: string) =>
          p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;
        const lines = tests.map((t) => {
          const hop = t.hops === 0 ? "direct" : `${t.hops}-hop`;
          return `${rel(t.file)}:${t.line + 1} ${t.symbol} (${hop})`;
        });
        return ok(`Tests for ${target}:\n${lines.join("\n")}`);
      } catch (e) {
        return err(`Find tests failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    async function handleImpactAnalysis(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const target = String(args.target || "");
      if (!target) return err("Missing required parameter: target");
      const depth = Math.min(Math.max(Number(args.depth) || 1, 1), 3);

      try {
        const { resolveTargetSymbols, findTests, findDependents, isTestPath } =
          await import("../lib/graph/impact");
        const db = getVectorDb();
        const { symbols, resolvedAsFile } = await resolveTargetSymbols(target, db, projectRoot);
        if (symbols.length === 0) return ok(`No symbols found for: ${target}`);

        const targetPath = resolvedAsFile ? path.resolve(projectRoot, target) : undefined;
        const excludePaths = targetPath ? new Set([targetPath]) : undefined;

        const [dependents, tests] = await Promise.all([
          findDependents(symbols, db, projectRoot, excludePaths),
          findTests(symbols, db, projectRoot, depth),
        ]);

        const nonTestDeps = dependents.filter((d) => !isTestPath(d.file));
        const rel = (p: string) =>
          p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;

        const sections: string[] = [`Impact analysis for ${target}:\n`];
        if (nonTestDeps.length > 0) {
          sections.push(`Dependents (${nonTestDeps.length}):`);
          for (const d of nonTestDeps) sections.push(`  ${rel(d.file)} (${d.sharedSymbols} shared)`);
        } else {
          sections.push("Dependents: none found");
        }
        sections.push("");
        if (tests.length > 0) {
          sections.push(`Affected tests (${tests.length}):`);
          for (const t of tests) {
            const hop = t.hops === 0 ? "direct" : `${t.hops}-hop`;
            sections.push(`  ${rel(t.file)}:${t.line + 1} ${t.symbol} (${hop})`);
          }
        } else {
          sections.push("Affected tests: none found");
        }
        return ok(sections.join("\n"));
      } catch (e) {
        return err(`Impact analysis failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    async function handleFindSimilar(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const target = String(args.target || "");
      if (!target) return err("Missing required parameter: target");
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 25);
      const threshold = Number(args.threshold) || 0;

      try {
        const db = getVectorDb();
        const table = await db.ensureTable();
        const isFile = target.includes("/") || (target.includes(".") && !target.includes(" "));

        let sourceRows: any[];
        if (isFile) {
          const absPath = path.resolve(projectRoot, target);
          sourceRows = await table.query()
            .select(["vector", "path", "start_line"])
            .where(`path = '${escapeSqlString(absPath)}'`)
            .limit(1).toArray();
        } else {
          sourceRows = await table.query()
            .select(["vector", "path", "start_line"])
            .where(`array_contains(defined_symbols, '${escapeSqlString(target)}')`)
            .limit(1).toArray();
        }

        if (sourceRows.length === 0) return ok(isFile ? `File not found: ${target}` : `Symbol not found: ${target}`);

        const source = sourceRows[0];
        if (!source.vector || source.vector.length === 0) return ok("Source chunk has no embedding.");

        const results = await table
          .vectorSearch(source.vector)
          .select(["path", "start_line", "defined_symbols", "role", "_distance"])
          .where(`path LIKE '${escapeSqlString(projectRoot)}/%'`)
          .limit(limit + 5).toArray();

        let filtered = results.filter((r: any) =>
          !(r.path === source.path && r.start_line === source.start_line));
        if (threshold > 0) filtered = filtered.filter((r: any) => 1 / (1 + (r._distance ?? 0)) >= threshold);

        if (filtered.length === 0) return ok(`No similar code found for ${target}.`);

        const rel = (p: string) =>
          p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;
        const lines = filtered.slice(0, limit).map((r: any) => {
          const sym = toStringArray(r.defined_symbols)?.[0] ?? "";
          return `${rel(r.path)}:${Number(r.start_line ?? 0) + 1} ${sym} [${r.role || "IMPL"}] d=${(r._distance ?? 0).toFixed(3)}`;
        });
        return ok(`Similar to ${target}:\n${lines.join("\n")}`);
      } catch (e) {
        return err(`Similar search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    async function handleBuildContext(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      ensureWatcher();
      const topic = String(args.topic || "");
      if (!topic) return err("Missing required parameter: topic");
      const budget = Math.max(Number(args.budget) || 4000, 500);
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);

      try {
        const searcher = getSearcher();
        const response = await searcher.search(topic, limit, { rerank: true }, {}, projectRoot);
        if (response.data.length === 0) return ok(`No results found for "${topic}".`);

        const rel = (p: string) =>
          p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;
        const estTokens = (s: string) => Math.ceil(s.length / 4);
        let tokensUsed = 0;
        const sections: string[] = [];

        // Entry points
        const epLines = response.data.slice(0, 5).map((r: any) => {
          const sym = toStringArray(r.defined_symbols)?.[0] ?? "";
          return `${rel(r.path)}:${Number(r.start_line ?? 0) + 1} ${sym} [${r.role || "IMPL"}]`;
        });
        const epSection = `## Entry Points\n${epLines.join("\n")}`;
        sections.push(epSection);
        tokensUsed += estTokens(epSection);

        // Key function bodies
        for (const r of response.data.slice(0, 3)) {
          const absP = String((r as any).path || "");
          const startLine = Number((r as any).start_line ?? 0);
          const endLine = Number((r as any).end_line ?? startLine);
          const sym = toStringArray((r as any).defined_symbols)?.[0] ?? "";
          try {
            const content = fs.readFileSync(absP, "utf-8");
            const body = content.split("\n").slice(startLine, endLine + 1).join("\n");
            const blob = `\n--- ${rel(absP)}:${startLine + 1} ${sym} ---\n${body}`;
            if (tokensUsed + estTokens(blob) > budget) break;
            sections.push(blob);
            tokensUsed += estTokens(blob);
          } catch { /* skip unreadable */ }
        }

        sections.push(`\n(~${tokensUsed}/${budget} tokens)`);
        return ok(sections.join("\n"));
      } catch (e) {
        return err(`Context generation failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // --- MCP server setup ---

    const transport = new StdioServerTransport();
    const server = new Server(
      {
        name: "gmax",
        version: JSON.parse(
          fs.readFileSync(path.join(__dirname, "../../package.json"), {
            encoding: "utf-8",
          }),
        ).version,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: TOOLS };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolArgs = (args ?? {}) as Record<string, unknown>;
      const startMs = Date.now();

      let result: ToolResult;
      switch (name) {
        case "semantic_search":
          result = await handleSemanticSearch(toolArgs, false);
          break;
        case "search_all":
          result = await handleSemanticSearch(toolArgs, true);
          break;
        case "code_skeleton":
          result = await handleCodeSkeleton(toolArgs);
          break;
        case "trace_calls":
          result = await handleTraceCalls(toolArgs);
          break;
        case "extract_symbol":
          result = await handleExtractSymbol(toolArgs);
          break;
        case "peek_symbol":
          result = await handlePeekSymbol(toolArgs);
          break;
        case "list_symbols":
          result = await handleListSymbols(toolArgs);
          break;
        case "index_status":
          result = await handleIndexStatus();
          break;
        case "summarize_directory":
          result = await handleSummarizeDirectory(toolArgs);
          break;
        case "summarize_project":
          result = await handleSummarizeProject(toolArgs);
          break;
        case "related_files":
          result = await handleRelatedFiles(toolArgs);
          break;
        case "recent_changes":
          result = await handleRecentChanges(toolArgs);
          break;
        case "diff_changes":
          result = await handleDiffChanges(toolArgs);
          break;
        case "find_tests":
          result = await handleFindTests(toolArgs);
          break;
        case "impact_analysis":
          result = await handleImpactAnalysis(toolArgs);
          break;
        case "find_similar":
          result = await handleFindSimilar(toolArgs);
          break;
        case "build_context":
          result = await handleBuildContext(toolArgs);
          break;
        case "investigate": {
          const question = String(toolArgs.question || "");
          if (!question) { result = err("Missing required parameter: question"); break; }
          const maxRounds = Math.min(Math.max(Number(toolArgs.max_rounds) || 10, 1), 15);
          try {
            const { isDaemonRunning, sendDaemonCommand } = await import("../lib/utils/daemon-client");
            if (await isDaemonRunning()) {
              const llmResp = await sendDaemonCommand({ cmd: "llm-start" }, { timeoutMs: 90_000 });
              if (!llmResp.ok) {
                result = err(`LLM server not available: ${llmResp.error}. Run \`gmax llm on && gmax llm start\`.`);
                break;
              }
            } else {
              result = err("LLM server not available. Run `gmax llm on && gmax llm start`.");
              break;
            }
            const { investigate } = await import("../lib/llm/investigate");
            const inv = await investigate({ question, projectRoot, maxRounds });
            result = ok(inv.answer);
          } catch (e) {
            result = err(`Investigate failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          break;
        }
        case "review_commit": {
          const commitRef = String(toolArgs.commit || "HEAD");
          try {
            const { isDaemonRunning, sendDaemonCommand } = await import("../lib/utils/daemon-client");
            if (await isDaemonRunning()) {
              const llmResp = await sendDaemonCommand({ cmd: "llm-start" }, { timeoutMs: 90_000 });
              if (!llmResp.ok) {
                result = err(`LLM server not available: ${llmResp.error}. Run \`gmax llm on && gmax llm start\`.`);
                break;
              }
            } else {
              result = err("LLM server not available. Run `gmax llm on && gmax llm start`.");
              break;
            }
            const { reviewCommit } = await import("../lib/llm/review");
            const rev = await reviewCommit({ commitRef, projectRoot });
            if (rev.clean) {
              result = ok(`Clean commit (${rev.commit}) — no issues found in ${rev.duration}s.`);
            } else {
              const { readReport } = await import("../lib/llm/report");
              const report = readReport(projectRoot);
              const entry = report?.reviews.find((r) => r.commit === rev.commit);
              result = ok(JSON.stringify({ commit: rev.commit, findings: entry?.findings ?? [], duration: rev.duration }, null, 2));
            }
          } catch (e) {
            result = err(`Review failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          break;
        }
        case "review_report": {
          try {
            const { readReport, formatReportText } = await import("../lib/llm/report");
            const report = readReport(projectRoot);
            if (!report || report.reviews.length === 0) {
              result = ok("No review findings yet.");
            } else if (toolArgs.json) {
              result = ok(JSON.stringify(report, null, 2));
            } else {
              result = ok(formatReportText(report));
            }
          } catch (e) {
            result = err(`Report failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          break;
        }
        default:
          return err(`Unknown tool: ${name}`);
      }

      // Best-effort query logging
      try {
        const { logQuery } = await import("../lib/utils/query-log");
        const text = result.content?.[0]?.text ?? "";
        const resultLines = text.split("\n").filter((l) => l.trim()).length;
        logQuery({
          ts: new Date().toISOString(),
          source: "mcp",
          tool: name,
          query: String(toolArgs.query ?? toolArgs.symbol ?? toolArgs.target ?? ""),
          project: projectRoot,
          results: resultLines,
          ms: Date.now() - startMs,
          error: result.isError ? text.slice(0, 200) : undefined,
        });
      } catch {}

      return result;
    });

    await server.connect(transport);

    // Kick off index readiness check and watcher in background
    ensureIndexReady().catch((e) =>
      console.error("[MCP] Index readiness check failed:", e),
    );
    ensureWatcher();
  });
