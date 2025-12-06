import { GraphBuilder } from "../src/lib/graph/graph-builder";
import { VectorDB } from "../src/lib/store/vector-db";
import {
  ensureProjectPaths,
  findProjectRoot,
} from "../src/lib/utils/project-root";

async function testGraph() {
  const root = await findProjectRoot();
  const paths = await ensureProjectPaths(root);
  console.log("DB Path:", paths.lancedbDir);
  const db = new VectorDB(paths.lancedbDir);
  const builder = new GraphBuilder(db);

  const symbol = "Searcher";
  console.log(`Building graph for symbol: ${symbol}`);

  const graph = await builder.buildGraph(symbol);

  console.log("--- Center ---");
  if (graph.center) {
    console.log(`Symbol: ${graph.center.symbol}`);
    console.log(`File: ${graph.center.file}:${graph.center.line}`);
    console.log(`Role: ${graph.center.role}`);
    console.log(`Calls: ${graph.center.calls.join(", ")}`);
  } else {
    console.log("Center not found (Definition missing?)");
  }

  console.log("\n--- Callers ---");
  if (graph.callers.length > 0) {
    graph.callers.forEach((c) => {
      console.log(`- ${c.symbol} (${c.file}:${c.line})`);
    });
  } else {
    console.log("No callers found.");
  }

  console.log("\n--- Callees ---");
  if (graph.callees.length > 0) {
    console.log(graph.callees.join(", "));
  } else {
    console.log("No callees found.");
  }
}

testGraph().catch(console.error);
