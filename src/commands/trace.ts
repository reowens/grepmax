import { Command } from "commander";
import { findCallSiteSnippet } from "../lib/graph/callsites";
import { GraphBuilder } from "../lib/graph/graph-builder";
import { formatTrace } from "../lib/output/formatter";
import { VectorDB } from "../lib/store/vector-db";
import { symbolNotFoundLines } from "../lib/utils/agent-errors";
import { gracefulExit } from "../lib/utils/exit";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import {
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (useColors ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s: string) => (useColors ? `\x1b[1m${s}\x1b[22m` : s);

function formatTraceAgent(graph: {
  center: { symbol: string; file: string; line: number; role: string } | null;
  callerTree: Array<{ node: { symbol: string; file: string; line: number }; callers: any[] }>;
  callees: Array<{ symbol: string; file: string; line: number }>;
  importers: string[];
}, projectRoot: string): string {
  if (!graph.center) return "(not found)";
  const rel = (p: string) =>
    p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p;
  const lines: string[] = [];
  lines.push(
    `${graph.center.symbol}\t${rel(graph.center.file)}:${graph.center.line}\t${graph.center.role}`,
  );
  function walkCallers(tree: any[], depth: number) {
    for (const t of tree) {
      lines.push(`${"  ".repeat(depth)}<- ${t.node.symbol}\t${rel(t.node.file)}:${t.node.line}`);
      walkCallers(t.callers, depth + 1);
    }
  }
  walkCallers(graph.callerTree, 0);
  for (const c of graph.callees) {
    if (c.file) {
      lines.push(`-> ${c.symbol}\t${rel(c.file)}:${c.line}`);
    } else {
      lines.push(`-> ${c.symbol}\t(not indexed)`);
    }
  }
  return lines.join("\n");
}

interface InboundCaller {
  symbol: string;
  file: string;
  line: number;
  snippet: string | null;
  snippetLine: number | null;
  callers: InboundCaller[];
}

function buildInboundTree(
  callerTree: Array<{ node: { symbol: string; file: string; line: number }; callers: any[] }>,
  targetSymbol: string,
  fileCache: Map<string, string[]>,
  withSnippets: boolean,
  limit: number,
): InboundCaller[] {
  const out: InboundCaller[] = [];
  // Dedupe by call-site location: when getCallers returns multiple chunks of
  // the same file (e.g. several methods of a class) that all reference the
  // target on the same line, collapse them into one row.
  const seen = new Set<string>();
  for (const t of callerTree) {
    const snippet = withSnippets
      ? findCallSiteSnippet(fileCache, t.node.file, t.node.line, targetSymbol)
      : null;
    const dedupeKey = `${t.node.file}:${snippet?.snippetLine ?? t.node.line}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      symbol: t.node.symbol,
      file: t.node.file,
      line: t.node.line,
      snippet: snippet?.snippet ?? null,
      snippetLine: snippet?.snippetLine ?? null,
      callers: buildInboundTree(t.callers, t.node.symbol, fileCache, withSnippets, limit),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function formatInboundAgent(
  center: { symbol: string; file: string; line: number; role: string },
  tree: InboundCaller[],
  projectRoot: string,
  withSnippets: boolean,
): string {
  const rel = (p: string) =>
    p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p;
  const lines: string[] = [];
  lines.push(
    `${center.symbol}\t${rel(center.file)}:${center.line + 1}\t${center.role}`,
  );
  const walk = (nodes: InboundCaller[], depth: number) => {
    for (const n of nodes) {
      const prefix = "  ".repeat(depth);
      const loc = n.file ? `${rel(n.file)}:${(n.snippetLine ?? n.line) + 1}` : "(not indexed)";
      const cols = withSnippets
        ? `${loc}\t${n.symbol}\t${n.snippet ?? ""}`
        : `${loc}\t${n.symbol}`;
      lines.push(`${prefix}${cols}`);
      walk(n.callers, depth + 1);
    }
  };
  walk(tree, 0);
  return lines.join("\n");
}

function formatInboundHuman(
  center: { symbol: string; file: string; line: number; role: string },
  tree: InboundCaller[],
  projectRoot: string,
  withSnippets: boolean,
): string {
  const rel = (p: string) =>
    p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p;
  const flatCount = (() => {
    let n = 0;
    const walk = (nodes: InboundCaller[]) => {
      for (const node of nodes) {
        n++;
        walk(node.callers);
      }
    };
    walk(tree);
    return n;
  })();
  const lines: string[] = [];
  lines.push(
    `${bold(`inbound callers of ${center.symbol}`)} ${dim(`(${flatCount})`)}`,
  );
  lines.push(
    `  ${dim(`${rel(center.file)}:${center.line + 1}  [${center.role}]`)}`,
  );
  if (tree.length === 0) {
    lines.push(dim("  (none in scope)"));
    return lines.join("\n");
  }
  const walk = (nodes: InboundCaller[], depth: number) => {
    for (const n of nodes) {
      const indent = "  ".repeat(depth + 1);
      const loc = n.file
        ? `${rel(n.file)}:${(n.snippetLine ?? n.line) + 1}`
        : "(not indexed)";
      lines.push(`${indent}${n.symbol}  ${dim(loc)}`);
      if (withSnippets && n.snippet) {
        lines.push(`${indent}  ${dim(n.snippet)}`);
      }
      walk(n.callers, depth + 1);
    }
  };
  walk(tree, 0);
  return lines.join("\n");
}

export const trace = new Command("trace")
  .description("Trace the call graph for a symbol")
  .argument("<symbol>", "The symbol to trace")
  .option("-d, --depth <n>", "Caller traversal depth (default 1, max 3)", "1")
  .option("--root <dir>", "Project root directory")
  .option(
    "--in <subpath>",
    "Restrict to a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
  )
  .option(
    "--exclude <subpath>",
    "Exclude a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
  )
  .option("--agent", "Compact output for AI agents", false)
  .option("--inbound", "Show only callers, with call-site snippets", false)
  .option("--no-snippets", "Suppress call-site snippets in --inbound output")
  .option("--limit <n>", "Max callers shown per node in --inbound (default 10)", "10")
  .action(async (symbol, opts) => {
    const depth = Math.min(
      Math.max(Number.parseInt(opts.depth || "1", 10), 1),
      3,
    );
    const inboundLimit = Math.min(
      Math.max(Number.parseInt(opts.limit || "10", 10), 1),
      30,
    );
    const root = resolveRootOrExit(opts.root);
    if (root === null) return;
    let vectorDb: VectorDB | null = null;

    try {
      const projectRoot = findProjectRoot(root) ?? root;
      maybeWarnStaleChunker(projectRoot, { agent: opts.agent });
      maybeWarnStaleEmbedding(projectRoot, { agent: opts.agent });
      const paths = ensureProjectPaths(projectRoot);

      vectorDb = new VectorDB(paths.lancedbDir);

      const { resolveScope } = await import("../lib/utils/scope-filter");
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });
      const graphBuilder = new GraphBuilder(
        vectorDb,
        scope.pathPrefix,
        scope.excludePrefixes,
      );
      const graph = await graphBuilder.buildGraphMultiHop(symbol, depth);

      if (opts.inbound) {
        if (!graph.center) {
          console.log(
            symbolNotFoundLines(symbol, { agent: opts.agent }).join("\n"),
          );
          process.exitCode = 1;
        } else {
          const fileCache = new Map<string, string[]>();
          const withSnippets = opts.snippets !== false;
          const tree = buildInboundTree(
            graph.callerTree,
            symbol,
            fileCache,
            withSnippets,
            inboundLimit,
          );
          if (opts.agent) {
            console.log(
              formatInboundAgent(graph.center, tree, projectRoot, withSnippets),
            );
          } else {
            console.log(
              formatInboundHuman(graph.center, tree, projectRoot, withSnippets),
            );
          }
        }
      } else if (opts.agent) {
        console.log(formatTraceAgent(graph, projectRoot));
        if (!graph.center) process.exitCode = 1;
      } else {
        console.log(formatTrace(graph, { symbol }));
        if (!graph.center) process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Trace failed:", message);
      process.exitCode = 1;
    } finally {
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
