import { Command } from "commander";
import {
  callGraphVerb,
  type GraphTraceResult,
  runGraphTrace,
} from "../lib/daemon/graph-handler";
import { findCallSiteSnippet } from "../lib/graph/callsites";
import {
  addTraceCoverageObservation,
  normalizeTraceMetadata,
  type TraceCoverage,
  traceEvidenceNote,
  traceEvidenceSummary,
  withTraceDisplayCoverage,
} from "../lib/graph/trace-evidence";
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
import { reportStoreAccessRefusal } from "../lib/utils/store-access";

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (useColors ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s: string) => (useColors ? `\x1b[1m${s}\x1b[22m` : s);

// Inferred-edge marker for caller rows: `member` = receiver-unverified `x.T()`,
// `type` = a type-position reference. Legacy free rows stay unmarked; the shared
// trace note explains that none of these classifications establishes binding.
const kindTag = (k?: "free" | "member" | "type") =>
  k === "member" || k === "type" ? ` (${k})` : "";

function formatTraceAgent(
  graph: GraphTraceResult,
  projectRoot: string,
  raw = false,
): string {
  let coverage = normalizeTraceMetadata(graph, 1).coverage;
  if (!graph.center) return `(not found)\n${traceEvidenceSummary(coverage)}`;
  const center = graph.center;
  const rel = (p: string) =>
    p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p;
  const lines: string[] = [];
  let callerRows = 0;
  let displayedCallers = 0;
  const countRows = (tree: GraphTraceResult["callerTree"]): void => {
    for (const t of tree) {
      callerRows++;
      countRows(t.callers);
    }
  };
  countRows(graph.callerTree);
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
        displayedCallers++;
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
      displayedCallers++;
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
      lines.push(
        `-> ${c.symbol}\t(${c.resolution === "ambiguous-member" ? "receiver unresolved" : "not indexed"})`,
      );
    }
  }
  coverage = withTraceDisplayCoverage(
    coverage,
    "display_callers",
    callerRows,
    displayedCallers,
    null,
    callerRows - displayedCallers,
  );
  coverage = withTraceDisplayCoverage(
    coverage,
    "display_callees",
    graph.callees.length,
    graph.callees.length,
  );
  coverage = withTraceDisplayCoverage(
    coverage,
    "display_importers",
    graph.importers.length,
    0,
    null,
    graph.importers.length,
  );
  lines.push(traceEvidenceSummary(coverage));
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
  display: { coverage: TraceCoverage },
): InboundCaller[] {
  const out: InboundCaller[] = [];
  // Dedupe by live snippet location: when getCallers returns multiple chunks of
  // the same file (e.g. several methods of a class) that all reference the
  // target on the same line, collapse them into one row.
  const seen = new Set<string>();
  let processed = 0;
  let stoppedEarly = false;
  for (const t of callerTree) {
    processed++;
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
        display,
      ),
    });
    if (out.length >= limit) {
      stoppedEarly = processed < callerTree.length;
      break;
    }
  }
  // Preserve the existing content-read boundary. Unread siblings may dedupe to
  // the displayed prefix, so the cap cannot establish an exact omitted count.
  display.coverage = stoppedEarly
    ? addTraceCoverageObservation(display.coverage, "display_callers", {
        observed: processed,
        retained: out.length,
        filteredByPolicy: processed - seen.size,
        limit,
        limited: true,
        status: "unknown",
        reasons: ["display_limit_dedupe_unknown"],
        omitted: { exact: null, lowerBound: 0 },
      })
    : withTraceDisplayCoverage(
        display.coverage,
        "display_callers",
        processed,
        out.length,
        limit,
        processed - seen.size,
      );
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
    const parsedDepth = Number.parseInt(opts.depth || "1", 10);
    const requestedDepth =
      Number.isFinite(parsedDepth) && parsedDepth > 0 ? parsedDepth : null;
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
    // Opened only if the daemon is unreachable; withStoreRead decides.
    const local: { db: VectorDB | null } = { db: null };

    try {
      const projectRoot = findProjectRoot(root) ?? root;
      maybeWarnStaleChunker(projectRoot, { agent: opts.agent });
      maybeWarnStaleEmbedding(projectRoot, { agent: opts.agent });

      const { resolveScope } = await import("../lib/utils/scope-filter");
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });

      // The daemon returns the graph; call-site snippets below are read from
      // the working tree by this process, which can already see it.
      const graph = await callGraphVerb<GraphTraceResult>("graph.trace", {
        projectRoot,
        scope,
        payload: { target: symbol, hops: depth, requestedDepth },
        render: (resp) => resp.graph as GraphTraceResult,
        inProcess: () => {
          local.db ??= new VectorDB(ensureProjectPaths(projectRoot).lancedbDir);
          return runGraphTrace(local.db, {
            symbol,
            hops: depth,
            scope,
            requestedDepth,
          });
        },
      });
      Object.assign(
        graph,
        normalizeTraceMetadata(graph, Number.isFinite(depth) ? depth : 1),
      );

      if (opts.inbound) {
        if (!graph.center) {
          console.log(
            [
              ...symbolNotFoundLines(symbol, { agent: opts.agent }),
              opts.agent
                ? traceEvidenceSummary(graph.coverage!)
                : traceEvidenceNote(graph.coverage!),
            ].join("\n"),
          );
          process.exitCode = 1;
        } else {
          const fileCache = new Map<string, string[]>();
          const withSnippets = opts.snippets !== false;
          const display = { coverage: graph.coverage! };
          const tree = buildInboundTree(
            graph.callerTree,
            symbol,
            fileCache,
            withSnippets,
            inboundLimit,
            display,
          );
          display.coverage = withTraceDisplayCoverage(
            display.coverage,
            "display_callees",
            graph.callees.length,
            0,
            null,
            graph.callees.length,
          );
          display.coverage = withTraceDisplayCoverage(
            display.coverage,
            "display_importers",
            graph.importers.length,
            0,
            null,
            graph.importers.length,
          );
          if (opts.agent) {
            console.log(
              `${formatInboundAgent(graph.center, tree, projectRoot, withSnippets)}\n${traceEvidenceSummary(display.coverage)}`,
            );
          } else {
            console.log(
              `${formatInboundHuman(graph.center, tree, projectRoot, withSnippets)}\n${traceEvidenceNote(display.coverage)}`,
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
      // A sandbox refusal is already one actionable line; a "Trace failed:"
      // prefix would bury the settings key that fixes it.
      if (!reportStoreAccessRefusal(error)) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error("Trace failed:", message);
        process.exitCode = 1;
      }
    } finally {
      if (local.db) {
        try {
          await local.db.close();
        } catch (err) {
          console.error("Failed to close VectorDB:", err);
        }
      }
      await gracefulExit();
    }
  });
