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
    const results: { rr: number; found: boolean; path: string; query: string; note?: string }[] = [];

    for (const c of cases) {
        const res = await store.search(storeId, c.query, topK);
        const rank = res.data.findIndex((chunk) =>
            chunk.metadata?.path?.toLowerCase().includes(c.expectedPath.toLowerCase()),
        );
        const rr = rank >= 0 ? 1 / (rank + 1) : 0;
        results.push({ rr, found: rank >= 0, path: c.expectedPath, query: c.query, note: c.note });
    }

    const mrr = results.reduce((sum, r) => sum + r.rr, 0) / results.length;

    console.log("Eval results for store:", storeId);
    results.forEach((r) => {
        const status = r.found ? `rank ${(1 / r.rr).toFixed(0)}` : "missed";
        console.log(`- ${r.query} => ${status} (target: ${r.path})${r.note ? ` // ${r.note}` : ""}`);
    });
    console.log(`MRR: ${mrr.toFixed(3)}`);
}

run().catch((err) => {
    console.error("Eval failed:", err);
    process.exitCode = 1;
});
