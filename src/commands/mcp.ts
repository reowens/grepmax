import * as fs from "node:fs";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import { PATHS } from "../config";
import { GraphBuilder } from "../lib/graph/graph-builder";
import { readIndexConfig } from "../lib/index/index-config";
import { initialSync } from "../lib/index/syncer";
import { Searcher } from "../lib/search/searcher";
import { getStoredSkeleton } from "../lib/skeleton/retriever";
import { Skeletonizer } from "../lib/skeleton/skeletonizer";
import { VectorDB } from "../lib/store/vector-db";
import { escapeSqlString, normalizePath } from "../lib/utils/filter-builder";
import { listProjects } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

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
          description: "Max results to return (default 10, max 50)",
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
          description: "Max results to return (default 10, max 50)",
        },
        min_score: {
          type: "number",
          description: "Minimum relevance score (0-1). Default: 0",
        },
        max_per_file: {
          type: "number",
          description: "Max results per file (default: no cap).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "code_skeleton",
    description:
      "Show the structure of a source file — all function/class/method signatures with bodies collapsed. Useful for understanding large files without reading every line. Returns ~4x fewer tokens than the full file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "File path relative to project root (e.g. 'src/services/booking.ts')",
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
  .description("Start MCP server for gmax")
  .action(async (_optsArg, _cmd) => {
    // --- Lifecycle ---

    let _vectorDb: VectorDB | null = null;
    let _searcher: Searcher | null = null;
    let _skeletonizer: Skeletonizer | null = null;
    let _indexReady = false;

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

    async function ensureIndexReady(): Promise<void> {
      if (_indexReady) return;

      try {
        const db = getVectorDb();
        const hasIndex = await db.hasAnyRows();

        if (!hasIndex) {
          console.log("[MCP] No index found, running initial sync...");
          await initialSync({ projectRoot });
          console.log("[MCP] Initial sync complete.");
        } else {
          console.log("[MCP] Index exists, ready.");
        }

        _indexReady = true;
      } catch (e) {
        console.error("[MCP] Index sync failed:", e);
      }
    }

    // --- Tool handlers ---

    async function handleSemanticSearch(
      args: Record<string, unknown>,
      searchAll = false,
    ): Promise<ToolResult> {
      const query = String(args.query || "");
      if (!query) return err("Missing required parameter: query");

      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);

      await ensureIndexReady();

      try {
        const searcher = getSearcher();

        // Determine path prefix for scoping
        let pathPrefix: string | undefined;

        if (!searchAll) {
          // Resolve search root — default to project root
          const searchRoot =
            typeof args.root === "string"
              ? path.resolve(args.root)
              : path.resolve(projectRoot);

          pathPrefix = searchRoot.endsWith("/")
            ? searchRoot
            : `${searchRoot}/`;

          // If a sub-path is specified, append it
          if (typeof args.path === "string") {
            pathPrefix = path.join(searchRoot, args.path);
            if (!pathPrefix.endsWith("/")) pathPrefix += "/";
          }
        }

        const result = await searcher.search(
          query,
          limit,
          { rerank: true },
          undefined,
          pathPrefix,
        );

        if (!result.data || result.data.length === 0) {
          return ok("No matches found.");
        }

        const minScore =
          typeof args.min_score === "number" ? args.min_score : 0;
        const maxPerFile =
          typeof args.max_per_file === "number" ? args.max_per_file : 0;

        const MAX_SNIPPET_LINES = 8;

        let compact = result.data.map((r: any) => {
          const startLine =
            r.startLine ?? r.generated_metadata?.start_line ?? 0;
          const raw =
            typeof r.content === "string"
              ? r.content
              : typeof r.text === "string"
                ? r.text
                : "";

          // Add line numbers and cap at MAX_SNIPPET_LINES
          const lines = raw.split("\n");
          const capped = lines.slice(0, MAX_SNIPPET_LINES);
          const numbered = capped.map(
            (line: string, i: number) => `${startLine + i + 1}│${line}`,
          );
          const snippet =
            lines.length > MAX_SNIPPET_LINES
              ? `${numbered.join("\n")}\n… (+${lines.length - MAX_SNIPPET_LINES} more lines)`
              : numbered.join("\n");

          return {
            path: r.path ?? r.metadata?.path ?? "",
            startLine,
            endLine: r.endLine ?? r.generated_metadata?.end_line ?? 0,
            score: typeof r.score === "number" ? +r.score.toFixed(3) : 0,
            role: r.role ?? "IMPLEMENTATION",
            confidence: r.confidence ?? "Unknown",
            definedSymbols: toStringArray(
              r.definedSymbols ?? r.defined_symbols,
            ).slice(0, 5),
            snippet,
          };
        });

        if (minScore > 0) {
          compact = compact.filter((r) => r.score >= minScore);
        }

        if (maxPerFile > 0) {
          const counts = new Map<string, number>();
          compact = compact.filter((r) => {
            const count = counts.get(r.path) || 0;
            if (count >= maxPerFile) return false;
            counts.set(r.path, count + 1);
            return true;
          });
        }

        return ok(JSON.stringify(compact));
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

      const absPath = path.resolve(projectRoot, target);

      if (!fs.existsSync(absPath)) {
        return err(`File not found: ${target}`);
      }

      // Try cached skeleton first (stored with absolute path)
      try {
        const db = getVectorDb();
        const cached = await getStoredSkeleton(db, absPath);
        if (cached) {
          const tokens = Math.ceil(cached.length / 4);
          return ok(`// ${target} (~${tokens} tokens)\n\n${cached}`);
        }
      } catch {
        // Index may not exist yet — fall through to live generation
      }

      // Generate skeleton from file
      try {
        const content = fs.readFileSync(absPath, "utf-8");
        const skel = await getSkeletonizer();
        const result = await skel.skeletonizeFile(absPath, content);

        if (!result.success && result.error) {
          return err(`Skeleton generation failed: ${result.error}`);
        }

        return ok(
          `// ${target} (~${result.tokenEstimate} tokens)\n\n${result.skeleton}`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Skeleton failed: ${msg}`);
      }
    }

    async function handleTraceCalls(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      const symbol = String(args.symbol || "");
      if (!symbol) return err("Missing required parameter: symbol");

      try {
        const db = getVectorDb();
        const builder = new GraphBuilder(db);
        const graph = await builder.buildGraph(symbol);

        if (!graph.center) {
          return ok(`Symbol '${symbol}' not found in the index.`);
        }

        const lines: string[] = [];

        // Callers
        if (graph.callers.length > 0) {
          lines.push("Callers (who calls this?):");
          for (const caller of graph.callers) {
            lines.push(`  <- ${caller.symbol} (${caller.file}:${caller.line})`);
          }
        } else {
          lines.push("No known callers.");
        }

        lines.push("");

        // Center
        lines.push(`${graph.center.symbol}`);
        lines.push(`  Defined in ${graph.center.file}:${graph.center.line}`);
        lines.push(`  Role: ${graph.center.role}`);

        lines.push("");

        // Callees
        if (graph.callees.length > 0) {
          lines.push("Callees (what does this call?):");
          for (const callee of graph.callees) {
            lines.push(`  -> ${callee}`);
          }
        } else {
          lines.push("No known callees.");
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

      try {
        const db = getVectorDb();
        const table = await db.ensureTable();

        let query = table
          .query()
          .select(["defined_symbols", "path", "start_line"])
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
          { symbol: string; count: number; path: string; line: number }
        >();
        for (const row of rows) {
          const defs = toStringArray((row as any).defined_symbols);
          const rowPath = String((row as any).path || "");
          const line = Number((row as any).start_line || 0);
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

        return ok(JSON.stringify(entries));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Symbol listing failed: ${msg}`);
      }
    }

    async function handleIndexStatus(): Promise<ToolResult> {
      try {
        const config = readIndexConfig(PATHS.configPath);
        const projects = listProjects();

        const db = getVectorDb();
        const stats = await db.getStats();
        const fileCount = await db.getDistinctFileCount();

        return ok(
          JSON.stringify({
            store: "centralized (~/.gmax/lancedb)",
            totalChunks: stats.chunks,
            totalFiles: fileCount,
            totalBytes: stats.totalBytes,
            embedMode: config?.embedMode ?? "unknown",
            model: config?.embedModel ?? null,
            vectorDim: config?.vectorDim ?? null,
            indexedAt: config?.indexedAt ?? null,
            indexedDirectories: projects.map((p) => ({
              name: p.name,
              root: p.root,
              lastIndexed: p.lastIndexed,
            })),
          }),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Status check failed: ${msg}`);
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
        default:
          return err(`Unknown tool: ${name}`);
      }
    });

    await server.connect(transport);

    // Kick off index readiness check in background
    ensureIndexReady();
  });
