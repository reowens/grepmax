import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { GraphBuilder } from "../graph/graph-builder";
import {
  findDependents,
  findTests,
  resolveTargetSymbols,
} from "../graph/impact";
import type { Searcher } from "../search/searcher";
import type { SearchFilter } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { toArr } from "../utils/arrow";
import { escapeSqlString } from "../utils/filter-builder";

export interface InvestigateContext {
  vectorDb: VectorDB;
  searcher: Searcher;
  graphBuilder: GraphBuilder;
  projectRoot: string;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Semantic code search — finds code by meaning. Returns filepath:line symbol [ROLE] — snippet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          max_count: { type: "integer", description: "Max results (default 5)" },
          lang: { type: "string", description: "Filter by extension (e.g. 'ts', 'py')" },
          file: { type: "string", description: "Filter to files matching this name" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trace",
      description:
        "Full call graph — all callers (<-) and callees (->) with locations.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol name to trace" },
          depth: { type: "integer", description: "Caller depth 1-3 (default 1)" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "peek",
      description:
        "Compact symbol overview — signature, callers, and callees.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol name to peek at" },
          depth: { type: "integer", description: "Caller depth 1-3 (default 1)" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "impact",
      description:
        "Change impact — files that depend on this symbol/file, and affected tests.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Symbol name or file path" },
          depth: { type: "integer", description: "Traversal depth 1-3 (default 1)" },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "related",
      description:
        "Find files related by shared symbol references.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "File path relative to project root" },
        },
        required: ["file"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution wrappers
// ---------------------------------------------------------------------------

function rel(absPath: string, root: string): string {
  return absPath.startsWith(root) ? absPath.slice(root.length + 1) : absPath;
}

function clampDepth(d: unknown): number {
  const n = Number(d) || 1;
  return Math.min(Math.max(n, 1), 3);
}

async function executeSearch(
  args: Record<string, unknown>,
  ctx: InvestigateContext,
): Promise<string> {
  const query = String(args.query || "");
  if (!query) return "(error: missing query)";

  const limit = Math.min(Number(args.max_count) || 5, 10);
  const filters: SearchFilter = {};
  if (args.lang) filters.language = String(args.lang);
  if (args.file) filters.file = String(args.file);
  const pathPrefix = `${ctx.projectRoot}/`;

  const resp = await ctx.searcher.search(
    query,
    limit,
    { rerank: true },
    Object.keys(filters).length > 0 ? filters : undefined,
    pathPrefix,
  );

  if (!resp.data || resp.data.length === 0) return "(no results)";

  const lines = resp.data.map((r: any) => {
    const absPath = String(
      r.metadata?.path ?? r.path ?? "",
    );
    const rp = rel(absPath, ctx.projectRoot);
    const defs = toArr(r.definedSymbols ?? r.defined_symbols);
    const sym = defs[0] || "(anonymous)";
    const role = String(r.role ?? "IMPL").slice(0, 4).toUpperCase();
    const startLine =
      r.startLine ?? r.generated_metadata?.start_line ?? r.start_line ?? 0;
    const hint = String(r.text ?? r.content ?? "").split("\n")[0].slice(0, 100);
    return `${rp}:${startLine} ${sym} [${role}] — ${hint}`;
  });

  return lines.join("\n");
}

async function executeTrace(
  args: Record<string, unknown>,
  ctx: InvestigateContext,
): Promise<string> {
  const symbol = String(args.symbol || "");
  if (!symbol) return "(error: missing symbol)";

  const depth = clampDepth(args.depth);
  const graph = await ctx.graphBuilder.buildGraphMultiHop(symbol, depth);

  if (!graph.center) return "(not found)";

  const lines: string[] = [];
  lines.push(
    `${graph.center.symbol}\t${rel(graph.center.file, ctx.projectRoot)}:${graph.center.line}\t${graph.center.role}`,
  );

  function walkCallers(tree: any[], d: number) {
    for (const t of tree) {
      lines.push(
        `${"  ".repeat(d)}<- ${t.node.symbol}\t${rel(t.node.file, ctx.projectRoot)}:${t.node.line}`,
      );
      walkCallers(t.callers, d + 1);
    }
  }
  walkCallers(graph.callerTree, 0);

  for (const c of graph.callees) {
    if (c.file) {
      lines.push(`-> ${c.symbol}\t${rel(c.file, ctx.projectRoot)}:${c.line}`);
    } else {
      lines.push(`-> ${c.symbol}\t(not indexed)`);
    }
  }

  return lines.join("\n");
}

async function executePeek(
  args: Record<string, unknown>,
  ctx: InvestigateContext,
): Promise<string> {
  const symbol = String(args.symbol || "");
  if (!symbol) return "(error: missing symbol)";

  const graph = await ctx.graphBuilder.buildGraph(symbol);
  if (!graph.center) return "(not found)";

  const center = graph.center;
  const prefix = ctx.projectRoot.endsWith("/")
    ? ctx.projectRoot
    : `${ctx.projectRoot}/`;

  // Get metadata
  const table = await ctx.vectorDb.ensureTable();
  const metaRows = await table
    .query()
    .select(["is_exported", "start_line", "end_line"])
    .where(
      `array_contains(defined_symbols, '${escapeSqlString(symbol)}') AND path LIKE '${escapeSqlString(prefix)}%'`,
    )
    .limit(1)
    .toArray();

  const exported = metaRows.length > 0 && Boolean((metaRows[0] as any).is_exported);
  const startLine = metaRows.length > 0 ? Number((metaRows[0] as any).start_line || 0) : center.line;
  const endLine = metaRows.length > 0 ? Number((metaRows[0] as any).end_line || 0) : center.line;

  // Extract signature
  let sig = "(source not available)";
  try {
    const content = fs.readFileSync(center.file, "utf-8");
    const fileLines = content.split("\n");
    const chunk = fileLines.slice(startLine, endLine + 1);
    const sigLines: string[] = [];
    for (const line of chunk) {
      sigLines.push(line);
      if (line.includes("{") || line.includes("=>")) break;
    }
    sig = sigLines[0]?.trim() || sig;
  } catch {}

  const lines: string[] = [];
  lines.push(
    `${center.symbol}\t${rel(center.file, ctx.projectRoot)}:${center.line + 1}\t${center.role}\t${exported ? "exported" : ""}`,
  );
  lines.push(`sig: ${sig}`);

  for (const c of graph.callers.slice(0, 5)) {
    lines.push(
      `<- ${c.symbol}\t${c.file ? `${rel(c.file, ctx.projectRoot)}:${c.line + 1}` : "(not indexed)"}`,
    );
  }
  if (graph.callers.length > 5) {
    lines.push(`<- ... ${graph.callers.length - 5} more`);
  }

  for (const c of graph.callees.slice(0, 8)) {
    lines.push(
      `-> ${c.symbol}\t${c.file ? `${rel(c.file, ctx.projectRoot)}:${c.line + 1}` : "(not indexed)"}`,
    );
  }
  if (graph.callees.length > 8) {
    lines.push(`-> ... ${graph.callees.length - 8} more`);
  }

  return lines.join("\n");
}

async function executeImpact(
  args: Record<string, unknown>,
  ctx: InvestigateContext,
): Promise<string> {
  const target = String(args.target || "");
  if (!target) return "(error: missing target)";

  const depth = clampDepth(args.depth);
  const { symbols, resolvedAsFile } = await resolveTargetSymbols(
    target,
    ctx.vectorDb,
    ctx.projectRoot,
  );

  if (symbols.length === 0) return "(not found)";

  const excludePaths = resolvedAsFile
    ? new Set([path.resolve(ctx.projectRoot, target)])
    : undefined;

  const [deps, tests] = await Promise.all([
    findDependents(symbols, ctx.vectorDb, ctx.projectRoot, excludePaths),
    findTests(symbols, ctx.vectorDb, ctx.projectRoot, depth),
  ]);

  if (deps.length === 0 && tests.length === 0) return "(no impact detected)";

  const lines: string[] = [];
  for (const d of deps) {
    lines.push(`dep: ${rel(d.file, ctx.projectRoot)}\t${d.sharedSymbols}`);
  }
  for (const t of tests) {
    const hopLabel = t.hops === 0 ? "direct" : `${t.hops} hop${t.hops > 1 ? "s" : ""}`;
    lines.push(
      `test: ${rel(t.file, ctx.projectRoot)}:${t.line}\t${t.symbol}\t${hopLabel}`,
    );
  }

  return lines.join("\n");
}

async function executeRelated(
  args: Record<string, unknown>,
  ctx: InvestigateContext,
): Promise<string> {
  const filePath = String(args.file || "");
  if (!filePath) return "(error: missing file)";

  const absPath = path.resolve(ctx.projectRoot, filePath);
  const table = await ctx.vectorDb.ensureTable();

  // Get file's symbols
  const fileChunks = await table
    .query()
    .select(["defined_symbols", "referenced_symbols"])
    .where(`path = '${escapeSqlString(absPath)}'`)
    .toArray();

  if (fileChunks.length === 0) return "(file not indexed)";

  const definedHere = new Set<string>();
  const referencedHere = new Set<string>();
  for (const chunk of fileChunks) {
    for (const s of toArr((chunk as any).defined_symbols)) definedHere.add(s);
    for (const s of toArr((chunk as any).referenced_symbols)) referencedHere.add(s);
  }

  // Dependencies: files that DEFINE symbols this file REFERENCES
  const depCounts = new Map<string, number>();
  for (const sym of referencedHere) {
    if (definedHere.has(sym)) continue;
    const rows = await table
      .query()
      .select(["path"])
      .where(`array_contains(defined_symbols, '${escapeSqlString(sym)}')`)
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
      .where(`array_contains(referenced_symbols, '${escapeSqlString(sym)}')`)
      .limit(20)
      .toArray();
    for (const row of rows) {
      const p = String((row as any).path || "");
      if (p === absPath) continue;
      revCounts.set(p, (revCounts.get(p) || 0) + 1);
    }
  }

  const topDeps = [...depCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topRevs = [...revCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  if (topDeps.length === 0 && topRevs.length === 0) return "(none)";

  const lines: string[] = [];
  for (const [p, count] of topDeps) {
    lines.push(`dep: ${rel(p, ctx.projectRoot)}\t${count}`);
  }
  for (const [p, count] of topRevs) {
    lines.push(`rev: ${rel(p, ctx.projectRoot)}\t${count}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: InvestigateContext,
): Promise<string> {
  try {
    switch (name) {
      case "search":
        return await executeSearch(args, ctx);
      case "trace":
        return await executeTrace(args, ctx);
      case "peek":
        return await executePeek(args, ctx);
      case "impact":
        return await executeImpact(args, ctx);
      case "related":
        return await executeRelated(args, ctx);
      default:
        return `(error: unknown tool: ${name})`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `(error: ${msg})`;
  }
}
