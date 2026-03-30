import * as path from "node:path";
import { Command } from "commander";
import { GraphBuilder } from "../lib/graph/graph-builder";
import { formatTrace } from "../lib/output/formatter";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

export const trace = new Command("trace")
  .description("Trace the call graph for a symbol")
  .argument("<symbol>", "The symbol to trace")
  .option("-d, --depth <n>", "Caller traversal depth (default 1, max 3)", "1")
  .option("--root <dir>", "Project root directory")
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
      console.log(formatTrace(graph));
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
