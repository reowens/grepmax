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
import { GraphBuilder } from "../lib/graph/graph-builder";
import { getStoredSkeleton } from "../lib/skeleton/retriever";
import { Skeletonizer } from "../lib/skeleton/skeletonizer";
import { VectorDB } from "../lib/store/vector-db";
import {
  escapeSqlString,
  normalizePath,
} from "../lib/utils/filter-builder";
import {
  ensureProjectPaths,
  findProjectRoot,
} from "../lib/utils/project-root";
import {
  getServerForProject,
  isProcessRunning,
} from "../lib/utils/server-registry";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "semantic_search",
    description:
      "Search code by meaning. Use natural language queries like 'where do we validate permissions' or 'how does the booking flow work'. Returns ranked code snippets with file paths, line numbers, and relevance scores.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query. Be specific — more words give better results.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10, max 50)",
        },
        path: {
          type: "string",
          description: "Restrict search to files under this path prefix (e.g. 'src/auth/')",
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
          description: "File path relative to project root (e.g. 'src/services/booking.ts')",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "trace_calls",
    description:
      "Trace the call graph for a symbol — who calls it (callers) and what it calls (callees). Useful for understanding how functions connect across files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "The function, method, or class name to trace (e.g. 'handleAuth')",
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
          description: "Filter symbols by name (case-insensitive substring match)",
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
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toStringArray(val: unknown): string[] {
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

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const mcp = new Command("mcp")
  .description("Start MCP server for osgrep")
  .action(async (_optsArg, _cmd) => {
    // --- Lifecycle ---

    let _vectorDb: VectorDB | null = null;
    let _skeletonizer: Skeletonizer | null = null;

    const cleanup = async () => {
      if (_vectorDb) {
        try { await _vectorDb.close(); } catch {}
        _vectorDb = null;
      }
    };

    process.on("SIGINT", async () => {
      await cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      await cleanup();
      process.exit(0);
    });

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

    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
    const paths = ensureProjectPaths(projectRoot);

    // Lazy resource accessors
    async function getVectorDb(): Promise<VectorDB> {
      if (!_vectorDb) _vectorDb = new VectorDB(paths.lancedbDir);
      return _vectorDb;
    }

    async function getSkeletonizer(): Promise<Skeletonizer> {
      if (!_skeletonizer) {
        _skeletonizer = new Skeletonizer();
        await _skeletonizer.init();
      }
      return _skeletonizer;
    }

    // --- Tool handlers ---

    async function handleSemanticSearch(args: Record<string, unknown>): Promise<ToolResult> {
      const query = String(args.query || "");
      if (!query) return err("Missing required parameter: query");

      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const searchPath = typeof args.path === "string" ? args.path : undefined;

      const server = getServerForProject(projectRoot);
      if (!server || !isProcessRunning(server.pid)) {
        return err(
          "Search daemon not running. It should auto-start — try again in a few seconds, or run 'osgrep serve -b' manually.",
        );
      }

      try {
        const response = await fetch(`http://localhost:${server.port}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, limit, path: searchPath }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text();
          return err(`Search failed (${response.status}): ${body}`);
        }

        const { results } = (await response.json()) as { results: any[] };

        if (!results || results.length === 0) {
          return ok("No matches found.");
        }

        const compact = results.map((r: any) => ({
          path: r.metadata?.path ?? r.path ?? "",
          startLine: r.generated_metadata?.start_line ?? 0,
          endLine: r.generated_metadata?.end_line ?? 0,
          score: typeof r.score === "number" ? +r.score.toFixed(3) : 0,
          role: r.role ?? "IMPLEMENTATION",
          confidence: r.confidence ?? "Unknown",
          definedSymbols: toStringArray(r.defined_symbols).slice(0, 5),
          snippet: typeof r.text === "string" ? r.text : "",
        }));

        return ok(JSON.stringify(compact, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Search request failed: ${msg}`);
      }
    }

    async function handleCodeSkeleton(args: Record<string, unknown>): Promise<ToolResult> {
      const target = String(args.target || "");
      if (!target) return err("Missing required parameter: target");

      const absPath = path.resolve(projectRoot, target);
      const relPath = path.relative(projectRoot, absPath);

      // Security: ensure path is within project
      if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
        return err("Path must be within the project root.");
      }

      if (!fs.existsSync(absPath)) {
        return err(`File not found: ${target}`);
      }

      // Try cached skeleton first
      try {
        const db = await getVectorDb();
        const cached = await getStoredSkeleton(db, relPath);
        if (cached) {
          const tokens = Math.ceil(cached.length / 4);
          return ok(`// ${relPath} (~${tokens} tokens)\n\n${cached}`);
        }
      } catch {
        // Index may not exist yet — fall through to live generation
      }

      // Generate skeleton from file
      try {
        const content = fs.readFileSync(absPath, "utf-8");
        const skel = await getSkeletonizer();
        const result = await skel.skeletonizeFile(relPath, content);

        if (!result.success && result.error) {
          return err(`Skeleton generation failed: ${result.error}`);
        }

        return ok(
          `// ${relPath} (~${result.tokenEstimate} tokens)\n\n${result.skeleton}`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Skeleton failed: ${msg}`);
      }
    }

    async function handleTraceCalls(args: Record<string, unknown>): Promise<ToolResult> {
      const symbol = String(args.symbol || "");
      if (!symbol) return err("Missing required parameter: symbol");

      try {
        const db = await getVectorDb();
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

    async function handleListSymbols(args: Record<string, unknown>): Promise<ToolResult> {
      const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const pathPrefix = typeof args.path === "string" ? args.path : undefined;

      try {
        const db = await getVectorDb();
        const table = await db.ensureTable();

        let query = table
          .query()
          .select(["defined_symbols", "path", "start_line"])
          .where("array_length(defined_symbols) > 0")
          .limit(pattern ? 10000 : Math.max(limit * 50, 2000));

        if (pathPrefix) {
          query = query.where(
            `path LIKE '${escapeSqlString(normalizePath(pathPrefix))}%'`,
          );
        }

        const rows = await query.toArray();

        const map = new Map<string, { symbol: string; count: number; path: string; line: number }>();
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
              map.set(sym, { symbol: sym, count: 1, path: rowPath, line: Math.max(1, line + 1) });
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
          return ok("No symbols found. Run 'osgrep index' to build the index.");
        }

        return ok(JSON.stringify(entries, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Symbol listing failed: ${msg}`);
      }
    }

    // --- MCP server setup ---

    const transport = new StdioServerTransport();
    const server = new Server(
      {
        name: "osgrep",
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
          return handleSemanticSearch(toolArgs);
        case "code_skeleton":
          return handleCodeSkeleton(toolArgs);
        case "trace_calls":
          return handleTraceCalls(toolArgs);
        case "list_symbols":
          return handleListSymbols(toolArgs);
        default:
          return err(`Unknown tool: ${name}`);
      }
    });

    await server.connect(transport);

    // Ensure the serve daemon is running (handles indexing, GPU, live reindex).
    // The search CLI checks for a running daemon and uses it for GPU-accelerated search.
    setTimeout(() => {
      try {
        const existing = getServerForProject(projectRoot);

        if (existing && isProcessRunning(existing.pid)) {
          console.log(
            `[MCP] Serve daemon already running (PID: ${existing.pid}, Port: ${existing.port})`,
          );
          return;
        }

        console.log("[MCP] Starting serve daemon...");
        const child = spawn("osgrep", ["serve", "-b"], {
          cwd: projectRoot,
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        console.log(`[MCP] Serve daemon started (PID: ${child.pid})`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[MCP] Failed to start serve daemon:", msg);
      }
    }, 1000);
  });
