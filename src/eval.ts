process.env.OSGREP_WORKER_COUNT ??= "1";

import { performance } from "node:perf_hooks";
import { LocalStore } from "./lib/store/local-store";
import type { SearchResponse } from "./lib/store/store";
import { getAutoStoreId } from "./lib/store/store-utils";

export type EvalCase = {
  category: string;
  query: string;
  expected: string[];
  avoid?: string[];
  note?: string;
};

export type EvalResult = {
  category: string;
  query: string;
  note?: string;
  pathHint: string;
  rr: number;
  found: boolean;
  recall: number;
  timeMs: number;
};

const cases: EvalCase[] = [
  // --- Search + ranking ---
  {
    category: "Search + ranking",
    query: "How does osgrep blend dense, doc, and fts results?",
    expected: ["src/lib/search/searcher.ts"],
    note: "Hybrid retrieval merges code/doc vector results with FTS before rerank.",
  },
  {
    category: "Search + ranking",
    query: "Where is ColBERT maxSim scoring implemented?",
    expected: ["src/lib/search/colbert-math.ts", "src/lib/search/searcher.ts"],
    note: "ColBERT maxSim used for reranking hybrid candidates.",
  },
  {
    category: "Search + ranking",
    query: "boost function/class chunks over tests",
    expected: ["src/lib/search/searcher.ts"],
    note: "applyStructureBoost favors definitions and downranks docs/tests.",
  },
  {
    category: "Search + ranking",
    query: "scope search to a path prefix",
    expected: ["src/lib/search/searcher.ts"],
    note: "Path starts_with filter translated into a WHERE clause.",
  },
  {
    category: "Search + ranking",
    query: "What if full text search index is missing?",
    expected: ["src/lib/search/searcher.ts"],
    note: "FTS try/catch fallback to pure vector search with warnings.",
  },
  {
    category: "Search + ranking",
    query: "Warn when ColBERT dimensions differ from config",
    expected: ["src/lib/search/searcher.ts"],
    note: "colbertDim mismatch warning before scoring.",
  },
  {
    category: "Search + ranking",
    query: "Query prefix applied before encoding embeddings",
    expected: ["src/lib/search/searcher.ts", "src/config.ts"],
    note: "CONFIG.QUERY_PREFIX prepended to search strings.",
  },
  {
    category: "Search + ranking",
    query: "Map LanceDB rows back into chunk metadata",
    expected: ["src/lib/search/searcher.ts"],
    note: "mapRecordToChunk stitches path/hash/line metadata.",
  },

  // --- Embeddings + workers ---
  {
    category: "Embeddings + workers",
    query: "ONNX threading and worker thread count",
    expected: ["src/lib/workers/worker.ts"],
    note: "resolveThreadCount configures onnx intra/inter op threads.",
  },
  {
    category: "Embeddings + workers",
    query: "Quantized ColBERT reranker pipeline",
    expected: ["src/lib/workers/worker.ts"],
    note: "q8 ColBERT pipeline for late interaction rerank.",
  },
  {
    category: "Embeddings + workers",
    query: "Dense embedding pooling and normalization",
    expected: ["src/lib/workers/worker.ts"],
    note: "toDenseVectors pulls CLS/padded vectors and normalizes length.",
  },
  {
    category: "Embeddings + workers",
    query: "Pack ColBERT outputs into int8 with scale",
    expected: ["src/lib/workers/worker.ts"],
    note: "computeHybrid converts reranker outputs to int8 buffers + scale.",
  },
  {
    category: "Embeddings + workers",
    query: "Encode query into dense vector and ColBERT matrix",
    expected: ["src/lib/workers/worker.ts"],
    note: "encodeQuery emits dense vector plus token matrix and dim.",
  },
  {
    category: "Embeddings + workers",
    query: "Fallback to CPU if preferred device fails",
    expected: ["src/lib/workers/worker.ts"],
    note: "loadPipeline retries on cpu when device init fails.",
  },
  {
    category: "Embeddings + workers",
    query: "Prefer local models cache before remote download",
    expected: ["src/lib/workers/worker.ts"],
    note: "env.allowRemoteModels toggled after checking local cache dir.",
  },
  {
    category: "Embeddings + workers",
    query: "Worker manager serializes requests through a queue",
    expected: ["src/lib/workers/worker-manager.ts"],
    note: "enqueue enforces one in-flight request at a time.",
  },
  {
    category: "Embeddings + workers",
    query: "Recycle worker when memory or timeout is hit",
    expected: ["src/lib/workers/worker-manager.ts"],
    note: "Memory checks and timeout recycling prevent runaway RAM.",
  },
  {
    category: "Embeddings + workers",
    query: "Retry policy and timeout for embedding requests",
    expected: ["src/lib/workers/worker-manager.ts"],
    note: "attemptWorkerRequest retries with WORKER_TIMEOUT_MS guard.",
  },
  {
    category: "Embeddings + workers",
    query: "Download all models via a background worker",
    expected: ["src/lib/workers/download-worker.ts"],
    note: "Model download worker runs transformers pipelines with progress.",
  },
  {
    category: "Embeddings + workers",
    query: "Detect local models folder in project for dev",
    expected: ["src/lib/workers/worker.ts"],
    note: "PROJECT_ROOT models/ overrides cache for local testing.",
  },

  // --- Indexing + chunking ---
  {
    category: "Indexing + chunking",
    query: "Tree-sitter chunking with graceful fallback when grammar missing",
    expected: ["src/lib/index/chunker.ts"],
    note: "chunk() selects language or falls back to line-based chunks.",
  },
  {
    category: "Indexing + chunking",
    query: "Anchor chunk summarizing imports exports comments",
    expected: ["src/lib/index/chunker.ts"],
    note: "buildAnchorChunk captures imports/exports/comments/preamble.",
  },
  {
    category: "Indexing + chunking",
    query: "Chunk size and overlap limits",
    expected: ["src/lib/index/chunker.ts"],
    note: "MAX_CHUNK_LINES/MAX_CHUNK_CHARS with overlaps tuned for context.",
  },
  {
    category: "Indexing + chunking",
    query: "Breadcrumb formatting for chunk text",
    expected: ["src/lib/index/chunker.ts"],
    note: "formatChunkText prepends file breadcrumb headers.",
  },
  {
    category: "Indexing + chunking",
    query: "Language to grammar mapping and supported extensions",
    expected: ["src/lib/core/languages.ts"],
    note: "LANGUAGES table defines grammars and definition node types.",
  },
  {
    category: "Indexing + chunking",
    query: "Where are tree-sitter grammars downloaded to",
    expected: ["src/lib/index/grammar-loader.ts"],
    note: "GRAMMARS_DIR and ensureGrammars downloader.",
  },
  {
    category: "Indexing + chunking",
    query: "Split oversized chunks into overlapping windows",
    expected: ["src/lib/index/chunker.ts"],
    note: "splitByLines/splitByChars enforce overlaps for long blocks.",
  },
  {
    category: "Indexing + chunking",
    query: "Indexer attaches context_prev/next and anchor flags",
    expected: ["src/lib/index/indexer.ts"],
    note: "indexFile wires neighbors, chunk_index, is_anchor metadata.",
  },
  {
    category: "Indexing + chunking",
    query: "Indexing profile timing toggle",
    expected: ["src/lib/index/indexer.ts"],
    note: "PROFILE_ENABLED logs chunking/index timings.",
  },
  {
    category: "Indexing + chunking",
    query: "Embed batch size tuned by env flags",
    expected: ["src/lib/index/syncer.ts"],
    note: "resolveEmbedBatchSize uses OSGREP_BATCH_SIZE/FAST/LOW_IMPACT.",
  },
  {
    category: "Indexing + chunking",
    query: "Default ignore patterns for indexing",
    expected: ["src/lib/index/ignore-patterns.ts"],
    note: "DEFAULT_IGNORE_PATTERNS velvet-rope filters.",
  },
  {
    category: "Indexing + chunking",
    query: "Hidden files and gitignore filtering",
    expected: ["src/lib/index/scanner.ts"],
    note: "isIgnored checks dotfiles, .osgrepignore, .gitignore caches.",
  },
  {
    category: "Indexing + chunking",
    query: "Delete stale database entries for removed files",
    expected: ["src/lib/index/syncer.ts"],
    note: "stalePaths removal when files disappear from disk.",
  },
  {
    category: "Indexing + chunking",
    query: "Skip unchanged files using meta hashes",
    expected: ["src/lib/index/syncer.ts", "src/lib/store/meta-store.ts"],
    note: "MetaStore hash comparison avoids re-indexing.",
  },
  {
    category: "Indexing + chunking",
    query: "Convert prepared chunks to vectors via workerManager",
    expected: ["src/lib/index/syncer.ts"],
    note: "preparedChunksToVectors calls computeHybrid before writes.",
  },
  {
    category: "Indexing + chunking",
    query: "Live watcher reindexes modified files",
    expected: ["src/commands/serve.ts"],
    note: "chokidar watcher triggers indexFile + insertBatch on changes.",
  },

  // --- Storage + data ---
  {
    category: "Storage + data",
    query: "LanceDB schema and ensure table creation",
    expected: ["src/lib/store/vector-db.ts"],
    note: "baseSchemaRow and ensureTable set up vector table.",
  },
  {
    category: "Storage + data",
    query: "Create IVF vector index when row count is high",
    expected: ["src/lib/store/vector-db.ts"],
    note: "createVectorIndex builds ivf_flat when rows exceed threshold.",
  },
  {
    category: "Storage + data",
    query: "Create full-text index for content field",
    expected: ["src/lib/store/vector-db.ts"],
    note: "createFTSIndex builds FTS with lancedb.Index.fts.",
  },
  {
    category: "Storage + data",
    query: "Normalize vectors to configured dimension",
    expected: ["src/lib/store/vector-db.ts"],
    note: "normalizeVector pads/trims to CONFIG.VECTOR_DIMENSIONS.",
  },
  {
    category: "Storage + data",
    query: "List anchor records when enumerating files",
    expected: ["src/lib/store/vector-db.ts"],
    note: "listFiles streams anchor entries with hashes.",
  },
  {
    category: "Storage + data",
    query: "LocalStore wires indexer searcher and vector db",
    expected: ["src/lib/store/local-store.ts"],
    note: "LocalStore composes VectorDB + Indexer + Searcher.",
  },

  // --- CLI + server ---
  {
    category: "CLI + server",
    query: "Search command hits running server via lock file",
    expected: ["src/commands/search.ts", "src/lib/utils/lockfile.ts"],
    note: "tryServerFastPath uses server.json auth token for /search.",
  },
  {
    category: "CLI + server",
    query: "Serve /search endpoint enforces payload limits and indexing guard",
    expected: ["src/commands/serve.ts"],
    note: "MAX_REQUEST_BYTES and indexing_in_progress backpressure.",
  },
  {
    category: "CLI + server",
    query: "Server writes auth token lock file with PID",
    expected: ["src/commands/serve.ts", "src/lib/utils/lockfile.ts"],
    note: "writeServerLock stores port/pid/authToken in .osgrep/server.json.",
  },
  {
    category: "CLI + server",
    query: "Index command reset wipes store and meta cache",
    expected: ["src/commands/index.ts"],
    note: "--reset drops store and prunes meta.json entries.",
  },
  {
    category: "CLI + server",
    query: "Formatter presents agent/plain vs human outputs",
    expected: ["src/lib/utils/formatter.ts"],
    note: "Plain mode for agents; pretty mode stitches chunks for humans.",
  },
  {
    category: "CLI + server",
    query: "List command formats sizes and time ago",
    expected: ["src/commands/list.ts"],
    note: "formatSize/formatDate used when listing stores.",
  },
  {
    category: "CLI + server",
    query: "Doctor command verifies models data and grammars",
    expected: ["src/commands/doctor.ts"],
    note: "Health check shows PATHS and missing models.",
  },
  {
    category: "CLI + server",
    query: "Setup command downloads models and grammars",
    expected: ["src/commands/setup.ts", "src/lib/setup/setup-helpers.ts"],
    note: "ensureSetup + ensureGrammars prepare ~/.osgrep assets.",
  },
  {
    category: "CLI + server",
    query: "Claude Code plugin installation flow",
    expected: ["src/commands/claude-code.ts"],
    note: "install-claude-code wraps claude plugin marketplace/install.",
  },

  // --- Config + utilities ---
  {
    category: "Config + utilities",
    query: "Model ids and embedding dimensions configuration",
    expected: ["src/config.ts"],
    note: "MODEL_IDS and CONFIG.VECTOR_DIMENSIONS/COLBERT_DIM.",
  },
  {
    category: "Config + utilities",
    query: "Worker timeout and memory caps env vars",
    expected: ["src/config.ts"],
    note: "WORKER_TIMEOUT_MS and MAX_WORKER_MEMORY_MB defaults.",
  },
  {
    category: "Config + utilities",
    query: "Indexable extensions and max file size limit",
    expected: ["src/lib/utils/file-utils.ts"],
    note: "INDEXABLE_EXTENSIONS and 1MB guard in isIndexableFile.",
  },
  {
    category: "Config + utilities",
    query: "Compute sha256 for buffers to detect changes",
    expected: ["src/lib/utils/file-utils.ts"],
    note: "computeBufferHash/computeFileHash helpers.",
  },
  {
    category: "Config + utilities",
    query: "Debounce helper for batching watcher work",
    expected: ["src/lib/utils/debounce.ts"],
    note: "debounce utility used by serve watcher.",
  },
  {
    category: "Config + utilities",
    query: "Graceful exit helper before process termination",
    expected: ["src/lib/utils/exit.ts"],
    note: "gracefulExit waits to flush stdout/stderr.",
  },
  {
    category: "Config + utilities",
    query: "Auto-generate store id from git remote",
    expected: ["src/lib/store/store-utils.ts"],
    note: "getAutoStoreId extracts remote info or hashes path.",
  },
  {
    category: "Config + utilities",
    query: "Where is meta.json path configured",
    expected: ["src/config.ts", "src/lib/store/meta-store.ts"],
    note: "PATHS.meta drives MetaStore load/save location.",
  },
];

const storeId = process.argv[2] ?? getAutoStoreId(process.cwd());
const topK = Number.parseInt(process.env.OSGREP_EVAL_TOP_K ?? "25", 10);

function evaluateCase(
  response: SearchResponse,
  evalCase: EvalCase,
  timeMs: number,
): EvalResult {
  const expected = evalCase.expected.map((p) => p.toLowerCase());
  const avoid = (evalCase.avoid ?? []).map((p) => p.toLowerCase());

  const rank = response.data.findIndex((chunk) => {
    const path = chunk.metadata?.path?.toLowerCase() || "";
    return expected.some((target) => path.includes(target));
  });

  const avoidRank = response.data.findIndex((chunk) => {
    const path = chunk.metadata?.path?.toLowerCase() || "";
    return avoid.some((target) => path.includes(target));
  });

  const hitAvoid =
    avoid.length > 0 && avoidRank >= 0 && (rank === -1 || avoidRank < rank);
  const found = rank >= 0 && !hitAvoid;
  const rr = found ? 1 / (rank + 1) : 0;
  const recall = found && rank < 10 ? 1 : 0;

  return {
    category: evalCase.category,
    query: evalCase.query,
    note: evalCase.note,
    pathHint: evalCase.expected.join(" | "),
    rr,
    found,
    recall,
    timeMs,
  };
}

function summarize(results: EvalResult[]) {
  if (results.length === 0) {
    return { mrr: 0, recallAt10: 0, hits: 0, total: 0, avgMs: 0 };
  }
  const hits = results.filter((r) => r.found).length;
  const mrr = results.reduce((sum, r) => sum + r.rr, 0) / results.length;
  const recallAt10 =
    results.reduce((sum, r) => sum + r.recall, 0) / results.length;
  const avgMs = results.reduce((sum, r) => sum + r.timeMs, 0) / results.length;
  return { mrr, recallAt10, hits, total: results.length, avgMs };
}

async function assertStoreReady(store: LocalStore, id: string) {
  try {
    await store.retrieve(id);
  } catch {
    console.error(`❌ Store "${id}" does not exist!`);
    console.error(
      `   Run "osgrep index" first to create and populate the store.`,
    );
    process.exit(1);
  }

  const sanity = await store.search(id, "test", 1);
  if (sanity.data.length === 0) {
    console.error(`⚠️  Store "${id}" appears to be empty!`);
    console.error(`   Run "osgrep index" to populate the store with data.`);
    process.exit(1);
  }
}

async function run() {
  const store = new LocalStore();
  await assertStoreReady(store, storeId);

  const results: EvalResult[] = [];

  console.log(
    `Running ${cases.length} eval cases against store "${storeId}" (topK=${topK})...\n`,
  );
  const startTime = performance.now();

  for (const c of cases) {
    const queryStart = performance.now();
    const res = await store.search(storeId, c.query, topK);
    const timeMs = performance.now() - queryStart;
    results.push(evaluateCase(res, c, timeMs));
  }

  const totalTime = performance.now() - startTime;
  const overall = summarize(results);

  const byCategory = new Map<string, EvalResult[]>();
  for (const r of results) {
    const existing = byCategory.get(r.category) ?? [];
    existing.push(r);
    byCategory.set(r.category, existing);
  }

  console.log("=".repeat(80));
  console.log(`Eval results for store: ${storeId}`);
  console.log("=".repeat(80));
  results.forEach((r) => {
    const status = r.found ? `rank ${(1 / r.rr).toFixed(0)}` : "❌ missed";
    const emoji = r.found ? (r.rr === 1 ? "🎯" : "✓") : "❌";
    console.log(`[${r.category}] ${emoji} ${r.query}`);
    console.log(
      `   => ${status} (target: ${r.pathHint}) [${r.timeMs.toFixed(0)}ms]`,
    );
    if (r.note) console.log(`   // ${r.note}`);
  });

  console.log("=".repeat(80));
  console.log(
    `Overall • hits ${overall.hits}/${overall.total} • MRR ${overall.mrr.toFixed(3)} • Recall@10 ${overall.recallAt10.toFixed(3)} • Avg ${overall.avgMs.toFixed(0)}ms • Total ${totalTime.toFixed(0)}ms`,
  );

  console.log("\nPer-category:");
  for (const [category, group] of byCategory.entries()) {
    const stats = summarize(group);
    console.log(
      ` - ${category}: ${stats.hits}/${stats.total} hits • MRR ${stats.mrr.toFixed(3)} • Recall@10 ${stats.recallAt10.toFixed(3)} • Avg ${stats.avgMs.toFixed(0)}ms`,
    );
  }

  const misses = results.filter((r) => !r.found);
  if (misses.length > 0) {
    console.log("\nMisses to inspect:");
    misses.forEach((m) =>
      console.log(` - [${m.category}] ${m.query} (expected ${m.pathHint})`),
    );
  } else {
    console.log("\nAll cases matched their targets. 🎉");
  }

  const slowest = [...results]
    .sort((a, b) => b.timeMs - a.timeMs)
    .slice(0, 5);
  console.log("\nSlowest queries:");
  slowest.forEach((s) =>
    console.log(
      ` - ${s.query} [${s.category}] ${s.timeMs.toFixed(0)}ms ${
        s.found ? "" : "(missed)"
      }`,
    ),
  );
  console.log("=".repeat(80));
  process.exit(0);
}

run().catch((err) => {
  console.error("Eval failed:", err);
  process.exitCode = 1;
});
