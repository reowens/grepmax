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
import { getWatcherCoveringPath } from "../lib/utils/watcher-registry";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "semantic_search",
    description:
      "Search code by meaning within a directory. Use natural language queries like 'where do we validate permissions'. Searches the current project by default. Use `root` to search a different directory's index (e.g. a parent directory).",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Natural language search query. Be specific — more words give better results.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 3, max 50)",
        },
        root: {
          type: "string",
          description:
            "Directory to search (absolute or relative path). Defaults to the current project root. Use to search a parent or sibling directory's indexed code.",
        },
        path: {
          type: "string",
          description:
            "Restrict search to files under this path prefix (e.g. 'src/auth/'). Relative to the search root.",
        },
        detail: {
          type: "string",
          description:
            "Output detail: 'pointer' (default, metadata only), 'code' (4-line snippets), or 'full' (complete chunk content with line numbers)",
        },
        min_score: {
          type: "number",
          description:
            "Minimum relevance score (0-1). Results below this threshold are filtered out. Default: 0 (no filtering)",
        },
        max_per_file: {
          type: "number",
          description:
            "Max results per file (default: no cap). Useful to get diversity across files.",
        },
        file: {
          type: "string",
          description:
            "Filter to files matching this name (e.g. 'syncer.ts'). Matches the filename, not the full path.",
        },
        exclude: {
          type: "string",
          description:
            "Exclude files under this path prefix (e.g. 'tests/' or 'dist/').",
        },
        language: {
          type: "string",
          description:
            "Filter by file extension (e.g. 'ts', 'py', 'go'). Omit the dot.",
        },
        role: {
          type: "string",
          description:
            "Filter by chunk role: 'ORCHESTRATION' (logic/flow), 'DEFINITION' (types/classes), or 'IMPLEMENTATION'.",
        },
        context_lines: {
          type: "number",
          description:
            "Include N lines before and after the chunk (like grep -C). Only with detail 'code' or 'full'. Max 20.",
        },
        mode: {
          type: "string",
          description:
            "Search mode: 'default' (semantic only) or 'symbol' (semantic + call graph trace appended). Use 'symbol' when query is a function/class name.",
        },
        include_imports: {
          type: "boolean",
          description:
            "Prepend the file's import/require statements to each result. Deduped per file.",
        },
        name_pattern: {
          type: "string",
          description:
            "Regex to filter by symbol name (e.g. 'handle.*Auth'). Case-insensitive. Applied after search.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_all",
    description:
      "Search ALL indexed code across every directory. Use when you need to find code that could be anywhere. Returns results with full absolute paths so you know which project each result is from.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 3, max 50)",
        },
        detail: {
          type: "string",
          description:
            "Output detail: 'pointer' (default), 'code' (snippets), or 'full' (complete content)",
        },
        min_score: {
          type: "number",
          description: "Minimum relevance score (0-1). Default: 0",
        },
        max_per_file: {
          type: "number",
          description: "Max results per file (default: no cap).",
        },
        file: {
          type: "string",
          description:
            "Filter to files matching this name (e.g. 'syncer.ts').",
        },
        exclude: {
          type: "string",
          description:
            "Exclude files under this path prefix (e.g. 'tests/').",
        },
        language: {
          type: "string",
          description:
            "Filter by file extension (e.g. 'ts', 'py').",
        },
        role: {
          type: "string",
          description:
            "Filter by role: 'ORCHESTRATION', 'DEFINITION', or 'IMPLEMENTATION'.",
        },
        projects: {
          type: "string",
          description:
            "Comma-separated project names to include (e.g. 'platform,osgrep'). Use index_status to see names.",
        },
        exclude_projects: {
          type: "string",
          description:
            "Comma-separated project names to exclude (e.g. 'capstone,power').",
        },
        context_lines: {
          type: "number",
          description:
            "Include N lines before/after chunk. Only with detail 'code' or 'full'. Max 20.",
        },
        include_imports: {
          type: "boolean",
          description:
            "Prepend file's import statements to each result.",
        },
        name_pattern: {
          type: "string",
          description:
            "Regex to filter by symbol name (e.g. 'handle.*Auth').",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "code_skeleton",
    description:
      "Show the structure of source files — signatures with bodies collapsed (~4x fewer tokens). Accepts a file path, a directory path, or comma-separated file paths.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "File path, directory path (e.g. 'src/lib/search/'), or comma-separated files (e.g. 'src/a.ts,src/b.ts'). Relative to project root.",
        },
        limit: {
          type: "number",
          description:
            "Max files for directory mode (default 10, max 20). Ignored for single files.",
        },
        format: {
          type: "string",
          description:
            "Output format: 'text' (default) or 'json' (structured symbol list with names, lines, signatures).",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "trace_calls",
    description:
      "Trace the call graph for a symbol — who calls it (callers) and what it calls (callees). Searches across ALL indexed code to follow calls across project boundaries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description:
            "The function, method, or class name to trace (e.g. 'handleAuth')",
        },
        depth: {
          type: "number",
          description:
            "Traversal depth for callers (default 1, max 3). depth: 2 shows callers-of-callers.",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "list_symbols",
    description:
      "List indexed symbols (functions, classes, types) with their definition locations. Useful for finding where things are defined without knowing exact names.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description:
            "Filter symbols by name (case-insensitive substring match)",
        },
        limit: {
          type: "number",
          description: "Max symbols to return (default 20, max 100)",
        },
        path: {
          type: "string",
          description: "Only include symbols defined under this path prefix",
        },
      },
    },
  },
  {
    name: "index_status",
    description:
      "Check the status of the gmax index. Returns indexed directories, chunk counts, embed mode, index age, and watcher status.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "summarize_directory",
    description:
      "Generate LLM summaries for indexed code in a directory. Run after indexing. Summaries are stored and returned in search results. Requires the summarizer server on port 8101.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Directory to summarize (absolute or relative). Defaults to current project root.",
        },
        limit: {
          type: "number",
          description:
            "Max chunks to summarize per call (default 200, max 5000). Run again to continue.",
        },
      },
    },
  },
  {
    name: "summarize_project",
    description:
      "High-level overview of an indexed project — languages, directory structure, role distribution, key symbols, and entry points. Use when first exploring a codebase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        root: {
          type: "string",
          description:
            "Project root (absolute path). Defaults to current project.",
        },
      },
    },
  },
  {
    name: "related_files",
    description:
      "Find files related to a given file by shared symbol references. Shows dependencies (what this file calls) and dependents (what calls this file).",
    inputSchema: {
      type: "object" as const,
      properties: {
        file: {
          type: "string",
          description:
            "File path relative to project root (e.g. 'src/lib/index/syncer.ts')",
        },
        limit: {
          type: "number",
          description:
            "Max related files per direction (default 10)",
        },
      },
      required: ["file"],
    },
  },
  {
    name: "recent_changes",
    description:
      "Show recently modified files in the index. Useful after pulls or merges to see what changed.",
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
      console.log("[MCP] First-time index for this project...");

      const child = spawn(
        process.argv[0],
        [process.argv[1], "index", "--path", projectRoot],
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
          console.log("[MCP] First-time indexing complete.");
        } else {
          console.error(
            `[MCP] Indexing failed (exit code: ${code})`,
          );
        }
      });
    }

    // --- Background watcher ---

    function ensureWatcher(): void {
      if (getWatcherCoveringPath(projectRoot)) return;

      const child = spawn("gmax", ["watch", "-b", "--path", projectRoot], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      console.log(`[MCP] Started background watcher for ${projectRoot}`);
    }

    // --- Tool handlers ---

    async function handleSemanticSearch(
      args: Record<string, unknown>,
      searchAll = false,
    ): Promise<ToolResult> {
      const query = String(args.query || "");
      if (!query) return err("Missing required parameter: query");

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
          return ok("No matches found.");
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
          return ok(`Symbol '${symbol}' not found in the index.`);
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

    async function handleListSymbols(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
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
          return ok("No symbols found. Run 'gmax index' to build the index.");
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
          return ok(`File not found in index: ${file}`);
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
            return ok(`No indexed files found for ${root}`);
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

      switch (name) {
        case "semantic_search":
          return handleSemanticSearch(toolArgs, false);
        case "search_all":
          return handleSemanticSearch(toolArgs, true);
        case "code_skeleton":
          return handleCodeSkeleton(toolArgs);
        case "trace_calls":
          return handleTraceCalls(toolArgs);
        case "list_symbols":
          return handleListSymbols(toolArgs);
        case "index_status":
          return handleIndexStatus();
        case "summarize_directory":
          return handleSummarizeDirectory(toolArgs);
        case "summarize_project":
          return handleSummarizeProject(toolArgs);
        case "related_files":
          return handleRelatedFiles(toolArgs);
        case "recent_changes":
          return handleRecentChanges(toolArgs);
        default:
          return err(`Unknown tool: ${name}`);
      }
    });

    await server.connect(transport);

    // Kick off index readiness check and watcher in background
    ensureIndexReady().catch((e) =>
      console.error("[MCP] Index readiness check failed:", e),
    );
    ensureWatcher();
  });
