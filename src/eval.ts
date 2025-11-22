import { LocalStore } from "./lib/local-store";

type EvalCase = {
    query: string;
    expectedPath: string;
    note?: string;
};

const cases: EvalCase[] = [
    {
        query: "Where do we compute reranker scores?",
        expectedPath: "src/lib/local-store.ts",
        note: "Should point to rerank integration in the search flow",
    },
    {
        query: "Which model generates embeddings?",
        expectedPath: "src/lib/worker.ts",
        note: "Embedding worker with large model config",
    },
    {
        query: "How are code chunks built with comments?",
        expectedPath: "src/lib/chunker.ts",
        note: "Comment-aware chunker and context window split",
    },
    {
        query: "What limits sync concurrency?",
        expectedPath: "src/utils.ts",
        note: "p-limit concurrency settings during sync",
    },
    {
        query: "How is the LanceDB vector index created?",
        expectedPath: "src/lib/local-store.ts",
        note: "Vector index configuration",
    },
];

const storeId = process.argv[2] ?? "default";
const topK = 20;

async function run() {
    const store = new LocalStore();
    const results: { rr: number; found: boolean; path: string; query: string; note?: string; timeMs: number }[] = [];

    console.log("Starting evaluation...\n");
    const startTime = performance.now();

    for (const c of cases) {
        const queryStart = performance.now();
        const res = await store.search(storeId, c.query, topK);
        const queryEnd = performance.now();
        const timeMs = queryEnd - queryStart;

        const rank = res.data.findIndex((chunk) =>
            chunk.metadata?.path?.toLowerCase().includes(c.expectedPath.toLowerCase()),
        );
        const rr = rank >= 0 ? 1 / (rank + 1) : 0;
        results.push({ rr, found: rank >= 0, path: c.expectedPath, query: c.query, note: c.note, timeMs });
    }

    const totalTime = performance.now() - startTime;
    const mrr = results.reduce((sum, r) => sum + r.rr, 0) / results.length;
    const avgTime = results.reduce((sum, r) => sum + r.timeMs, 0) / results.length;

    console.log("=".repeat(80));
    console.log(`Eval results for store: ${storeId}`);
    console.log("=".repeat(80));
    results.forEach((r) => {
        const status = r.found ? `rank ${(1 / r.rr).toFixed(0)}` : "❌ missed";
        const emoji = r.found ? (r.rr === 1 ? "🎯" : "✓") : "❌";
        console.log(`${emoji} ${r.query}`);
        console.log(`   => ${status} (target: ${r.path}) [${r.timeMs.toFixed(0)}ms]`);
        if (r.note) {
            console.log(`   // ${r.note}`);
        }
    });
    console.log("=".repeat(80));
    console.log(`MRR: ${mrr.toFixed(3)}`);
    console.log(`Avg query time: ${avgTime.toFixed(0)}ms`);
    console.log(`Total time: ${totalTime.toFixed(0)}ms`);
    console.log(`Found: ${results.filter(r => r.found).length}/${results.length}`);
    console.log("=".repeat(80));
}

run().catch((err) => {
    console.error("Eval failed:", err);
    process.exitCode = 1;
});
