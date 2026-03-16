import { performance } from "node:perf_hooks";
import { Searcher } from "../src/lib/search/searcher";
import { VectorDB } from "../src/lib/store/vector-db";
import {
  ensureProjectPaths,
  findProjectRoot,
} from "../src/lib/utils/project-root";

// Force old-engine style boosts for this check.
process.env.GMAX_CODE_BOOST = "1.25";
process.env.GMAX_TEST_PENALTY = "0.85";
process.env.GMAX_DOC_PENALTY = "0.5";

async function main() {
  const root = process.cwd();
  const projectRoot = findProjectRoot(root) ?? root;
  const paths = ensureProjectPaths(projectRoot);
  const db = new VectorDB(paths.lancedbDir);
  const searcher = new Searcher(db);

  const warmStart = performance.now();
  await searcher.search("test query", 1, { rerank: true });
  console.log(
    `Warmup Query Time: ${(performance.now() - warmStart).toFixed(0)}ms`,
  );

  const res = await searcher.search("TreeSitterParser", 5, { rerank: true });
  console.log("\nContext Visibility Check:");
  res.data.forEach((r, i) => {
    const path = r.metadata?.path ?? "";
    const score = typeof r.score === "number" ? r.score.toFixed(3) : "n/a";
    console.log(`${i + 1}. ${path} (Score: ${score})`);
    if (!r.text?.includes("TreeSitterParser")) {
      console.log("   (Matched via vectorized context, not literal text)");
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
