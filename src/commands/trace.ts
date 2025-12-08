import { Command } from "commander";
import { GraphBuilder } from "../lib/graph/graph-builder";
import { formatTrace } from "../lib/output/formatter";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

export const trace = new Command("trace")
  .description("Trace the call graph for a symbol")
  .argument("<symbol>", "The symbol to trace")
  .action(async (symbol) => {
    const root = process.cwd();
    let vectorDb: VectorDB | null = null;

    try {
      const projectRoot = findProjectRoot(root) ?? root;
      const paths = ensureProjectPaths(projectRoot);

      vectorDb = new VectorDB(paths.lancedbDir);

      const graphBuilder = new GraphBuilder(vectorDb);
      const graph = await graphBuilder.buildGraph(symbol);
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
