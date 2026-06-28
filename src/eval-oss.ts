/**
 * OSS-fixture evaluation harness — runs the search pipeline against
 * sverklo-bench P1 (definition lookup) fixtures ported from
 * github.com/sverklo/sverklo-bench (tasks/express.gen.ts,
 * tasks/lodash.gen.ts). Used to answer "does ColBERT rerank help on a
 * third-party fixture set, or are our 97 internal cases biased?"
 *
 * Usage:
 *   pnpm tsx src/eval-oss.ts express                  # rerank off (default)
 *   GMAX_EVAL_RERANK=1 pnpm tsx src/eval-oss.ts express
 *   pnpm tsx src/eval-oss.ts lodash --json
 *   pnpm tsx src/eval-oss.ts all                      # all datasets
 */

// Same precaution as src/eval.ts — pin worker pool to 1 to avoid ONNX
// concurrency issues during the back-to-back search runs.
process.env.GMAX_WORKER_COUNT ??= "1";

import * as path from "node:path";
import { Searcher } from "./lib/search/searcher";
import type { SearchResponse } from "./lib/store/types";
import { VectorDB } from "./lib/store/vector-db";
import { gracefulExit } from "./lib/utils/exit";
import { PATHS } from "./config";

interface OssCase {
  /** Stable id, e.g. "ex-p1-01" */
  id: string;
  /** Symbol name — used verbatim as the search query (sverklo P1 shape) */
  query: string;
  /** Path *relative to the OSS project root* where the symbol is defined */
  expectedFile: string;
  /** 1-indexed line of the definition site, per sverklo's ground truth */
  expectedLine: number;
  note?: string;
}

interface OssDataset {
  name: string;
  projectRoot: string;
  cases: OssCase[];
}

// ─── express 4.21.1 P1 — sverklo-bench/tasks/express.gen.ts resolved against
//     a fresh checkout. `merge` dropped: it's the utils-merge package, not
//     an in-tree definition, so the sverklo resolver returns no location.
const EXPRESS_CASES: OssCase[] = [
  {
    id: "ex-p1-01",
    query: "createApplication",
    expectedFile: "lib/express.js",
    expectedLine: 37,
  },
  {
    id: "ex-p1-02",
    query: "Route",
    expectedFile: "lib/router/route.js",
    expectedLine: 43,
  },
  {
    id: "ex-p1-03",
    query: "Layer",
    expectedFile: "lib/router/layer.js",
    expectedLine: 33,
  },
  {
    id: "ex-p1-04",
    query: "View",
    expectedFile: "lib/view.js",
    expectedLine: 52,
  },
  {
    id: "ex-p1-05",
    query: "query",
    expectedFile: "lib/express.js",
    expectedLine: 79,
    note: "re-export site — middleware/query.js doesn't match the function-decl patterns",
  },
  {
    id: "ex-p1-06",
    query: "init",
    expectedFile: "lib/middleware/init.js",
    expectedLine: 28,
  },
  {
    id: "ex-p1-07",
    query: "acceptParams",
    expectedFile: "lib/utils.js",
    expectedLine: 126,
  },
  {
    id: "ex-p1-08",
    query: "stringify",
    expectedFile: "lib/response.js",
    expectedLine: 1155,
  },
  {
    id: "ex-p1-09",
    query: "compileETag",
    expectedFile: "lib/utils.js",
    expectedLine: 150,
  },
];

// ─── lodash 4.17.21 P1 — hand-verified line numbers in lodash.js, copied
//     verbatim from sverklo-bench/tasks/lodash.gen.ts. All 10 live in the
//     same 17K-line UMD file, so line-window matching (NOT path-only match)
//     is what makes this fixture set discriminating.
const LODASH_CASES: OssCase[] = [
  {
    id: "ld-p1-01",
    query: "map",
    expectedFile: "lodash.js",
    expectedLine: 9620,
  },
  {
    id: "ld-p1-02",
    query: "filter",
    expectedFile: "lodash.js",
    expectedLine: 9239,
  },
  {
    id: "ld-p1-03",
    query: "reduce",
    expectedFile: "lodash.js",
    expectedLine: 9745,
  },
  {
    id: "ld-p1-04",
    query: "debounce",
    expectedFile: "lodash.js",
    expectedLine: 10372,
  },
  {
    id: "ld-p1-05",
    query: "throttle",
    expectedFile: "lodash.js",
    expectedLine: 10965,
  },
  {
    id: "ld-p1-06",
    query: "merge",
    expectedFile: "lodash.js",
    expectedLine: 13505,
    note: "var merge = createAssigner(...) binding site, not the re-export at 16689",
  },
  {
    id: "ld-p1-07",
    query: "cloneDeep",
    expectedFile: "lodash.js",
    expectedLine: 11155,
  },
  {
    id: "ld-p1-08",
    query: "get",
    expectedFile: "lodash.js",
    expectedLine: 13194,
  },
  {
    id: "ld-p1-09",
    query: "set",
    expectedFile: "lodash.js",
    expectedLine: 13741,
  },
  {
    id: "ld-p1-10",
    query: "chunk",
    expectedFile: "lodash.js",
    expectedLine: 6903,
  },
];

// ─── platform monorepo (private) — 15 hand-curated P1 cases across packages
//     to test the "modular monorepo" shape that neither express nor lodash
//     covers. Symbols resolved against the live checkout. Bare-symbol
//     queries match sverklo's P1 methodology so results are comparable.
const PLATFORM_CASES: OssCase[] = [
  {
    id: "pf-p1-01",
    query: "formatCents",
    expectedFile: "packages/shared/src/format.ts",
    expectedLine: 8,
  },
  {
    id: "pf-p1-02",
    query: "formatTimeAgo",
    expectedFile: "packages/shared/src/format.ts",
    expectedLine: 44,
  },
  {
    id: "pf-p1-03",
    query: "BeyondError",
    expectedFile: "packages/shared/src/errors.ts",
    expectedLine: 37,
  },
  {
    id: "pf-p1-04",
    query: "ErrorCodes",
    expectedFile: "packages/shared/src/errors.ts",
    expectedLine: 5,
  },
  {
    id: "pf-p1-05",
    query: "createDb",
    expectedFile: "packages/db/src/index.ts",
    expectedLine: 42,
  },
  {
    id: "pf-p1-06",
    query: "createDbAsync",
    expectedFile: "packages/db/src/index.ts",
    expectedLine: 50,
  },
  {
    id: "pf-p1-07",
    query: "authMiddleware",
    expectedFile: "packages/api/src/middleware/auth.ts",
    expectedLine: 39,
  },
  {
    id: "pf-p1-08",
    query: "requireAuth",
    expectedFile: "packages/api/src/middleware/auth.ts",
    expectedLine: 45,
  },
  {
    id: "pf-p1-09",
    query: "resolveActor",
    expectedFile: "packages/api/src/middleware/auth.ts",
    expectedLine: 71,
  },
  {
    id: "pf-p1-10",
    query: "getActor",
    expectedFile: "packages/api/src/middleware/auth.ts",
    expectedLine: 1136,
  },
  {
    id: "pf-p1-11",
    query: "rateLimit",
    expectedFile: "packages/api/src/middleware/rate-limit.ts",
    expectedLine: 94,
  },
  {
    id: "pf-p1-12",
    query: "checkRateLimitKey",
    expectedFile: "packages/api/src/middleware/rate-limit.ts",
    expectedLine: 158,
  },
  {
    id: "pf-p1-13",
    query: "errorHandler",
    expectedFile: "packages/api/src/middleware/error.ts",
    expectedLine: 128,
  },
  {
    id: "pf-p1-14",
    query: "activityTracker",
    expectedFile: "packages/api/src/middleware/activity-tracker.ts",
    expectedLine: 17,
  },
  {
    id: "pf-p1-15",
    query: "initializeApp",
    expectedFile: "packages/api/src/app.ts",
    expectedLine: 68,
  },
];

const DATASETS: Record<string, OssDataset> = {
  express: {
    name: "express",
    projectRoot: path.join(
      process.env.HOME ?? "",
      "Development/sandbox/bench-fixtures/express",
    ),
    cases: EXPRESS_CASES,
  },
  lodash: {
    name: "lodash",
    projectRoot: path.join(
      process.env.HOME ?? "",
      "Development/sandbox/bench-fixtures/lodash",
    ),
    cases: LODASH_CASES,
  },
  platform: {
    name: "platform",
    projectRoot: path.join(
      process.env.HOME ?? "",
      "Development/beyond/platform",
    ),
    cases: PLATFORM_CASES,
  },
};

interface OssResult {
  id: string;
  query: string;
  expectedFile: string;
  expectedLine: number;
  rank: number; // 0 = miss; 1 = first hit
  rr: number; // reciprocal rank (1/rank, 0 if missed)
  recall10: number; // 1 if rank ≤ 10
  timeMs: number;
  note?: string;
}

// A chunk matches when its file path ends with the expected file AND either:
//   (b) it declares the queried symbol (`defined_symbols` includes it), OR
//   (a) the expected line falls within [start_line, end_line].
//
// (b) is the primary, drift-robust criterion for these symbol-lookup cases: it
// credits the searcher for surfacing the chunk that *defines* the symbol,
// regardless of where the hand-curated `expectedLine` lands relative to
// post-reindex chunk boundaries. Before this, stale expectedLine values (e.g.
// `requireAuth` def moved to lines 57-76 but the case said 45) and one-line
// boundary off-by-ones (BeyondError chunk starts at line 37; the line check
// tested `36 >= 37`) scored 7/15 platform cases as misses even though the
// defining chunk was returned at ranks 1-3 — masking real recall (0.333 → 0.800).
// (a) is kept as a fallback for re-export / binding-site cases (express `query`,
// lodash `merge`) whose answer chunk legitimately doesn't carry the symbol in
// `defined_symbols`. end_line falls back to start_line + 200 when missing.
function chunkMatches(
  chunk: SearchResponse["data"][number],
  expectedFile: string,
  expectedLine: number,
  expectedSymbol?: string,
): boolean {
  const path = String(chunk.metadata?.path || "").toLowerCase();
  if (
    !path.endsWith(`/${expectedFile.toLowerCase()}`) &&
    !path.endsWith(expectedFile.toLowerCase())
  ) {
    return false;
  }
  // (b) defining-chunk match
  if (expectedSymbol) {
    const defs = (chunk as any).defined_symbols;
    if (Array.isArray(defs) && defs.includes(expectedSymbol)) return true;
  }
  // (a) line-range match — chunks are 0-indexed start_line; expected line is 1-indexed
  const start = Number(
    chunk.generated_metadata?.start_line ?? (chunk as any).start_line ?? 0,
  );
  const numLines = Number(chunk.generated_metadata?.num_lines ?? 0);
  const end = numLines > 0 ? start + numLines : start + 200;
  return expectedLine - 1 >= start && expectedLine - 1 <= end;
}

function evaluateOss(
  response: SearchResponse,
  c: OssCase,
  timeMs: number,
): OssResult {
  const idx = response.data.findIndex((chunk) =>
    // `query` is the symbol name (sverklo P1 shape), so it doubles as the
    // expected defined-symbol for the drift-robust match branch.
    chunkMatches(chunk, c.expectedFile, c.expectedLine, c.query),
  );
  const rank = idx + 1; // 0 = miss
  const rr = rank > 0 ? 1 / rank : 0;
  const recall10 = rank > 0 && rank <= 10 ? 1 : 0;
  return {
    id: c.id,
    query: c.query,
    expectedFile: c.expectedFile,
    expectedLine: c.expectedLine,
    rank,
    rr,
    recall10,
    timeMs,
    note: c.note,
  };
}

async function runDataset(
  ds: OssDataset,
  rerank: boolean,
  topK: number,
): Promise<{
  summary: {
    dataset: string;
    rerank: boolean;
    cases: number;
    hits: number;
    hitsAt1: number;
    mrrAt10: number;
    recallAt10: number;
    avgTimeMs: number;
  };
  results: OssResult[];
}> {
  const vectorDb = new VectorDB(PATHS.lancedbDir);
  const searcher = new Searcher(vectorDb);
  const pathPrefix = ds.projectRoot.endsWith("/")
    ? ds.projectRoot
    : `${ds.projectRoot}/`;

  const results: OssResult[] = [];
  for (const c of ds.cases) {
    const t0 = performance.now();
    const res = await searcher.search(
      c.query,
      topK,
      { rerank },
      undefined,
      pathPrefix,
    );
    const timeMs = performance.now() - t0;
    results.push(evaluateOss(res, c, timeMs));
  }

  await vectorDb.close();

  const hits = results.filter((r) => r.rank > 0).length;
  const hitsAt1 = results.filter((r) => r.rank === 1).length;
  const mrr = results.reduce((s, r) => s + r.rr, 0) / results.length;
  const recall10 = results.reduce((s, r) => s + r.recall10, 0) / results.length;
  const avgTime = results.reduce((s, r) => s + r.timeMs, 0) / results.length;

  return {
    summary: {
      dataset: ds.name,
      rerank,
      cases: results.length,
      hits,
      hitsAt1,
      mrrAt10: Number(mrr.toFixed(4)),
      recallAt10: Number(recall10.toFixed(4)),
      avgTimeMs: Math.round(avgTime),
    },
    results,
  };
}

async function run() {
  const args = process.argv.slice(2);
  const datasetArg = args.find((a) => !a.startsWith("--")) ?? "all";
  const jsonMode =
    args.includes("--json") || process.env.GMAX_EVAL_JSON === "1";
  const rerank = process.env.GMAX_EVAL_RERANK === "1";
  const topK = 20;

  const wanted = datasetArg === "all" ? Object.keys(DATASETS) : [datasetArg];
  const out: Awaited<ReturnType<typeof runDataset>>[] = [];

  const log = jsonMode ? console.error : console.log;
  log(`OSS eval (rerank=${rerank ? "on" : "off"})`);

  for (const name of wanted) {
    const ds = DATASETS[name];
    if (!ds) {
      console.error(
        `Unknown dataset: ${name}. Known: ${Object.keys(DATASETS).join(", ")}`,
      );
      process.exit(1);
    }
    log(`\n── ${ds.name} (${ds.cases.length} cases, ${ds.projectRoot})`);
    const r = await runDataset(ds, rerank, topK);
    out.push(r);
    if (!jsonMode) {
      for (const res of r.results) {
        const status = res.rank > 0 ? `rank ${res.rank}` : "miss";
        console.log(
          `  ${res.id}  ${res.query.padEnd(20)} → ${status.padEnd(8)} ${res.expectedFile}:${res.expectedLine} [${res.timeMs.toFixed(0)}ms]`,
        );
      }
      const s = r.summary;
      console.log(
        `  → MRR@10=${s.mrrAt10}  Recall@10=${s.recallAt10}  hits@1=${s.hitsAt1}/${s.cases}  avg=${s.avgTimeMs}ms`,
      );
    }
  }

  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify({ rerank, datasets: out }, null, 2)}\n`,
    );
  }

  await gracefulExit(0);
}

if (require.main === module && process.env.GMAX_EVAL_AUTORUN !== "0") {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
