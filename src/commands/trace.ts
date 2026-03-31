import * as path from "node:path";
import { Command } from "commander";
import { GraphBuilder } from "../lib/graph/graph-builder";
import { formatTrace } from "../lib/output/formatter";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

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

export const trace = new Command("trace")
  .description("Trace the call graph for a symbol")
  .argument("<symbol>", "The symbol to trace")
  .option("-d, --depth <n>", "Caller traversal depth (default 1, max 3)", "1")
  .option("--root <dir>", "Project root directory")
  .option("--agent", "Compact output for AI agents", false)
  .action(async (symbol, opts) => {
    const depth = Math.min(
      Math.max(Number.parseInt(opts.depth || "1", 10), 1),
      3,
    );
    const root = opts.root ? path.resolve(opts.root) : process.cwd();
    let vectorDb: VectorDB | null = null;

    try {
      const projectRoot = findProjectRoot(root) ?? root;
      const paths = ensureProjectPaths(projectRoot);

      vectorDb = new VectorDB(paths.lancedbDir);

      const graphBuilder = new GraphBuilder(vectorDb, projectRoot);
      const graph = await graphBuilder.buildGraphMultiHop(symbol, depth);
      if (opts.agent) {
        console.log(formatTraceAgent(graph, projectRoot));
      } else {
        console.log(formatTrace(graph, { symbol }));
      }
      if (!graph.center) {
        process.exitCode = 1;
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
