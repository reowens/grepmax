// experiments/ranking-test.ts

import { Searcher } from "../src/lib/search/searcher";
import { VectorDB } from "../src/lib/store/vector-db";
import { ensureProjectPaths } from "../src/lib/utils/project-root";

async function run() {
  const root = process.cwd();
  const paths = ensureProjectPaths(root);
  const db = new VectorDB(paths.lancedbDir);
  const searcher = new Searcher(db);

  const cases = [
    { query: "Request Validation", expected: "request_body_to_args" },
    { query: "Dependency Injection", expected: "solve_dependencies" },
  ];

  for (const c of cases) {
    console.log(`\n🔎 Query: "${c.query}"`);
    const results = await searcher.search(c.query, 10, { rerank: true });

    // Filter out this test file
    const filtered = results.data.filter(
      (r) => !r.metadata?.path.includes("ranking-test.ts"),
    );

    const found = filtered.findIndex(
      (r) =>
        r.metadata?.path.includes(c.expected) || r.text?.includes(c.expected),
    );

    if (found === 0) console.log(`✅ PASS: Found '${c.expected}' at rank #1`);
    else if (found > 0)
      console.log(`⚠️ WARN: Found '${c.expected}' at rank #${found + 1}`);
    else console.log(`❌ FAIL: Did not find '${c.expected}' in top results`);

    // Debug: Show top 3 roles/scores
    filtered.slice(0, 3).forEach((r, i) => {
      console.log(
        `   ${i + 1}. [${r.role ?? "UNK"}] ${r.metadata?.path} (Score: ${r.score.toFixed(3)})`,
      );
    });
  }
}

run();
