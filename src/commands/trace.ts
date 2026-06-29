import { Command } from "commander";
import { findCallSiteSnippet } from "../lib/graph/callsites";
import { GraphBuilder } from "../lib/graph/graph-builder";
import { formatTrace } from "../lib/output/formatter";
import { VectorDB } from "../lib/store/vector-db";
import { symbolNotFoundLines } from "../lib/utils/agent-errors";
import { gracefulExit } from "../lib/utils/exit";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (useColors ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s: string) => (useColors ? `\x1b[1m${s}\x1b[22m` : s);

// Inferred-edge marker for caller rows: `member` = receiver-unverified `x.T()`,
// `type` = a type-position reference (not a call). Free calls stay unmarked —
// the trustworthy default — so only guesses carry a tag.
const kindTag = (k?: "free" | "member" | "type") =>
  k === "member" || k === "type" ? ` (${k})` : "";

function formatTraceAgent(
  graph: {
    center: { symbol: string; file: string; line: number; role: string } | null;
    callerTree: Array<{
      node: { symbol: string; file: string; line: number };
      callers: any[];
    }>;
    callees: Array<{ symbol: string; file: string; line: number }>;
    importers: string[];
  },
  projectRoot: string,
  raw = false,
): string {
  if (!graph.center) return "(not found)";
  const center = graph.center;
  const rel = (p: string) =>
    p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p;
  const lines: string[] = [];
  lines.push(
    `${center.symbol}\t${rel(center.file)}:${center.line}\t${center.role}`,
  );
  // A "self edge" is the traced symbol referencing itself (recursion) or its own
  // definition chunk surfacing as a caller — noise in nearly every trace. Hidden
  // by default; --raw brings them back.
  const isSelfEdge = (n: { symbol: string; file: string; line: number }) =>
    n.symbol === center.symbol ||
    (n.file === center.file && n.line === center.line);

  function walkCallers(tree: any[], depth: number) {
    if (raw) {
      for (const t of tree) {
        lines.push(
          `${"  ".repeat(depth)}<- ${t.node.symbol}\t${rel(t.node.file)}:${t.node.line}${kindTag(t.node.edgeKind)}`,
        );
        walkCallers(t.callers, depth + 1);
      }
      return;
    }
    // Collapse repeated callers: the common flood is ONE caller symbol matched at
    // many call-sites (e.g. `mcp` ×9). Group by (symbol, file), merge their lines
    // onto a single row, and recurse into the union of their sub-callers.
    const groups = new Map<
      string,
      {
        symbol: string;
        file: string;
        lineSet: Set<number>;
        sub: any[];
        edgeKind?: "free" | "member" | "type";
      }
    >();
    const order: string[] = [];
    for (const t of tree) {
      if (isSelfEdge(t.node)) continue;
      const key = `${t.node.symbol}\t${t.node.file}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          symbol: t.node.symbol,
          file: t.node.file,
          lineSet: new Set(),
          sub: [],
          // Callers arrive free-first (getCallers sorts), so the first edgeKind
          // seen for this group is its highest-confidence one.
          edgeKind: t.node.edgeKind,
        };
        groups.set(key, g);
        order.push(key);
      }
      g.lineSet.add(t.node.line);
      g.sub.push(...t.callers);
    }
    for (const key of order) {
      const g = groups.get(key)!;
      const locs = [...g.lineSet].sort((a, b) => a - b).join(",");
      const loc = g.file ? `${rel(g.file)}:${locs}` : "(not indexed)";
      lines.push(
        `${"  ".repeat(depth)}<- ${g.symbol}\t${loc}${kindTag(g.edgeKind)}`,
      );
      walkCallers(g.sub, depth + 1);
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
  edgeKind?: "free" | "member" | "type";
  callers: InboundCaller[];
}

function buildInboundTree(
  callerTree: Array<{
    node: {
      symbol: string;
      file: string;
      line: number;
      edgeKind?: "free" | "member" | "type";
    };
    callers: any[];
  }>,
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
      edgeKind: t.node.edgeKind,
      callers: buildInboundTree(
        t.callers,
        t.node.symbol,
        fileCache,
        withSnippets,
        limit,
      ),
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
      const loc = n.file
        ? `${rel(n.file)}:${(n.snippetLine ?? n.line) + 1}`
        : "(not indexed)";
      const cols = withSnippets
        ? `${loc}\t${n.symbol}${kindTag(n.edgeKind)}\t${n.snippet ?? ""}`
        : `${loc}\t${n.symbol}${kindTag(n.edgeKind)}`;
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
      lines.push(
        `${indent}${n.symbol}  ${dim(loc)}${dim(kindTag(n.edgeKind))}`,
      );
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
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option(
    "--exclude <subpath>",
    "Exclude a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option("--agent", "Compact output for AI agents", false)
  .option("--inbound", "Show only callers, with call-site snippets", false)
  .option("--no-snippets", "Suppress call-site snippets in --inbound output")
  .option(
    "--limit <n>",
    "Max callers shown per node in --inbound (default 10)",
    "10",
  )
  .option(
    "--raw",
    "In --agent mode, list every call-site without collapsing repeated callers or hiding self-edges",
    false,
  )
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
        console.log(formatTraceAgent(graph, projectRoot, opts.raw));
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
