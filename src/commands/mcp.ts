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
import { readIndexConfig } from "../lib/index/index-config";
import { initialSync } from "../lib/index/syncer";
import { startWatcher, type WatcherHandle } from "../lib/index/watcher";
import { Searcher } from "../lib/search/searcher";
import { getStoredSkeleton } from "../lib/skeleton/retriever";
import { Skeletonizer } from "../lib/skeleton/skeletonizer";
import { MetaCache } from "../lib/store/meta-cache";
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
      "Search code by meaning. Use natural language queries like 'where do we validate permissions' or 'how does the booking flow work'. Returns ranked code snippets with file paths, line numbers, and relevance scores.",
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
        path: {
          type: "string",
          description:
            "Restrict search to files under this path prefix (e.g. 'src/auth/')",
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
        scope: {
          type: "string",
          description:
            "Search scope: 'current' (default) searches this project, 'all' searches all indexed projects.",
        },
        projects: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter to specific project names when scope is 'all' (e.g. ['webapp', 'api']). Matches project names from the registry.",
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
      "Trace the call graph for a symbol — who calls it (callers) and what it calls (callees). Useful for understanding how functions connect across files.",
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
      "Check the status of the gmax index. Returns file count, chunk count, embed mode, index age, and whether live watching is active.",
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
    let _metaCache: MetaCache | null = null;
    let _skeletonizer: Skeletonizer | null = null;
    let _watcher: WatcherHandle | null = null;
    let _indexReady = false;

    const cleanup = async () => {
      try {
        await _watcher?.close();
      } catch {}
      try {
        _metaCache?.close();
      } catch {}
      try {
        await _vectorDb?.close();
      } catch {}
      _vectorDb = null;
      _searcher = null;
      _metaCache = null;
      _watcher = null;
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

    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
    const paths = ensureProjectPaths(projectRoot);

    // Propagate project root to worker processes
    process.env.OSGREP_PROJECT_ROOT = paths.root;

    // Lazy resource accessors
    function getVectorDb(): VectorDB {
      if (!_vectorDb) _vectorDb = new VectorDB(paths.lancedbDir);
      return _vectorDb;
    }

    function getSearcher(): Searcher {
      if (!_searcher) _searcher = new Searcher(getVectorDb());
      return _searcher;
    }

    function getMetaCache(): MetaCache {
      if (!_metaCache) _metaCache = new MetaCache(paths.lmdbPath);
      return _metaCache;
    }

    async function getSkeletonizer(): Promise<Skeletonizer> {
      if (!_skeletonizer) {
        _skeletonizer = new Skeletonizer();
        await _skeletonizer.init();
      }
      return _skeletonizer;
    }

    // --- Index sync + file watcher ---

    async function ensureIndexReady(): Promise<void> {
      if (_indexReady) return;

      try {
        // Check if index already exists — skip expensive full sync if so
        const db = getVectorDb();
        const hasIndex = await db.hasAnyRows();

        if (!hasIndex) {
          // First time — need full index
          console.log("[MCP] No index found, running initial sync...");
          await initialSync({ projectRoot });
          console.log("[MCP] Initial sync complete.");
        } else {
          console.log("[MCP] Index exists, skipping sync.");
        }

        // Start file watcher for live reindexing
        _watcher = startWatcher({
          projectRoot,
          vectorDb: getVectorDb(),
          metaCache: getMetaCache(),
          dataDir: paths.dataDir,
          onReindex: (files, ms) => {
            console.log(`[MCP] Reindexed ${files} files in ${ms}ms`);
          },
        });

        _indexReady = true;
      } catch (e) {
        console.error("[MCP] Index sync failed:", e);
      }
    }

    // --- Tool handlers ---

    async function handleSemanticSearch(
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      const query = String(args.query || "");
      if (!query) return err("Missing required parameter: query");

      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const searchPath = typeof args.path === "string" ? args.path : undefined;
      const scope = typeof args.scope === "string" ? args.scope : "current";
      const projectFilter = Array.isArray(args.projects)
        ? (args.projects as string[])
        : undefined;

      await ensureIndexReady();

      try {
        let results: any[];

        if (scope === "all") {
          // Multi-project search
          results = [];
          let projects = listProjects();

          // Filter by project name if specified
          if (projectFilter && projectFilter.length > 0) {
            const names = new Set(projectFilter.map((n) => n.toLowerCase()));
            projects = projects.filter((p) => names.has(p.name.toLowerCase()));
          }

          // Filter by path prefix — match against project root paths
          if (searchPath && !projectFilter) {
            const normalizedPath = searchPath.toLowerCase();
            projects = projects.filter((p) =>
              p.root.toLowerCase().includes(normalizedPath),
            );
          }

          for (const project of projects) {
            try {
              const lanceDir = path.join(project.root, ".gmax", "lancedb");
              if (!fs.existsSync(lanceDir)) continue;

              const isCurrentProject = project.root === projectRoot;
              const db = isCurrentProject
                ? getVectorDb()
                : new VectorDB(lanceDir, project.vectorDim);

              const searcher = isCurrentProject
                ? getSearcher()
                : new Searcher(db);

              // Only pass searchPath as file filter if it wasn't used as project filter
              const filePathFilter =
                projectFilter || !searchPath ? undefined : searchPath;
              const result = await searcher.search(
                query,
                limit,
                { rerank: true },
                undefined,
                filePathFilter,
              );

              for (const r of result.data) {
                results.push({ ...r, _project: project.name });
              }

              // Close non-current project DBs
              if (!isCurrentProject) await db.close();
            } catch (e) {
              console.error(
                `[MCP] Search failed for project ${project.name}:`,
                e,
              );
            }
          }

          // Sort by score descending, take top limit
          results.sort(
            (a, b) => (b._score ?? b.score ?? 0) - (a._score ?? a.score ?? 0),
          );
          results = results.slice(0, limit);
        } else {
          // Current project search
          const searcher = getSearcher();
          const result = await searcher.search(
            query,
            limit,
            { rerank: true },
            undefined,
            searchPath,
          );
          results = result.data;
        }

        if (!results || results.length === 0) {
          return ok("No matches found.");
        }

        const minScore =
          typeof args.min_score === "number" ? args.min_score : 0;
        const maxPerFile =
          typeof args.max_per_file === "number" ? args.max_per_file : 0;

        let compact = results.map((r: any) => {
          const entry: any = {
            path: r.path ?? r.metadata?.path ?? "",
            startLine: r.startLine ?? r.generated_metadata?.start_line ?? 0,
            endLine: r.endLine ?? r.generated_metadata?.end_line ?? 0,
            score: typeof r.score === "number" ? +r.score.toFixed(3) : 0,
            role: r.role ?? "IMPLEMENTATION",
            confidence: r.confidence ?? "Unknown",
            definedSymbols: toStringArray(
              r.definedSymbols ?? r.defined_symbols,
            ).slice(0, 5),
            snippet:
              typeof r.content === "string"
                ? r.content
                : typeof r.text === "string"
                  ? r.text
                  : "",
          };
          if (r._project) entry.project = r._project;
          return entry;
        });

        if (minScore > 0) {
          compact = compact.filter((r: any) => r.score >= minScore);
        }

        if (maxPerFile > 0) {
          const counts = new Map<string, number>();
          compact = compact.filter((r: any) => {
            const count = counts.get(r.path) || 0;
            if (count >= maxPerFile) return false;
            counts.set(r.path, count + 1);
            return true;
          });
        }

        return ok(JSON.stringify(compact, null, 2));
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
        const db = getVectorDb();
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
          query = query.where(
            `path LIKE '${escapeSqlString(normalizePath(pathPrefix))}%'`,
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

        return ok(JSON.stringify(entries, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Symbol listing failed: ${msg}`);
      }
    }

    async function handleIndexStatus(): Promise<ToolResult> {
      try {
        const db = getVectorDb();
        const stats = await db.getStats();
        const fileCount = await db.getDistinctFileCount();
        const config = readIndexConfig(paths.configPath);

        return ok(
          JSON.stringify(
            {
              mode: "embedded",
              files: fileCount,
              chunks: stats.chunks,
              totalBytes: stats.totalBytes,
              vectorDim: config?.vectorDim ?? 384,
              modelTier: config?.modelTier ?? "small",
              embedMode: config?.embedMode ?? "cpu",
              model: config?.embedModel ?? null,
              indexedAt: config?.indexedAt ?? null,
              watching: _watcher !== null,
            },
            null,
            2,
          ),
        );
      } catch {
        const config = readIndexConfig(paths.configPath);
        return ok(
          JSON.stringify({
            mode: "embedded",
            indexed: !!config?.indexedAt,
            vectorDim: config?.vectorDim ?? null,
            modelTier: config?.modelTier ?? null,
            watching: false,
          }),
        );
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
          return handleSemanticSearch(toolArgs);
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

    // Index and start watching in the background (non-blocking)
    ensureIndexReady().catch((e) => {
      console.error("[MCP] Background index sync failed:", e);
    });
  });
