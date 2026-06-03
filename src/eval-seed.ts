/**
 * Seed-eval harness — measures Aider-style chat/file seeding (Phase 4).
 *
 * WHY A SEPARATE HARNESS. `bench:oss` (src/eval-oss.ts) uses bare-symbol P1
 * lookups with NO seed context, so it can only serve as a *no-seed regression
 * guard* for seeding (seeded path absent → results must be unchanged). It
 * cannot demonstrate that seeding *helps*: attaching a seed equal to the answer
 * file would be circular, and the fixtures carry no realistic "open files"
 * annotation.
 *
 * THE HONEST DESIGN. Every case here uses an *ambiguous* natural-language query
 * that legitimately matches several subsystems, plus a realistic seed (a file
 * an agent would have open, or a symbol they're discussing). The metric is the
 * rank of the *contextually-correct* answer file, measured twice: baseline (no
 * seed) vs seeded. Three case kinds:
 *
 *   - route:   same query, seed points at subsystem A → answer should be A's
 *              file (which a no-seed search ranks below a different subsystem).
 *              Non-circular because the SAME query under a DIFFERENT seed must
 *              route to a DIFFERENT, independently-valid answer — something no
 *              static ranking can do.
 *   - recover: the contextually-correct file is OUT of the no-seed top-K
 *              entirely; seeding must pull it back via candidate-generation
 *              weight (a rerank-only seed could never recover an out-of-pool
 *              item — this case is the load-bearing proof of "weight in
 *              candidate generation, not rerank").
 *   - guard:   the seed is IRRELEVANT to the query; the no-seed rank-1 file must
 *              stay rank 1. Catches seeding doing harm.
 *
 * Baselines below were measured live against the gmax index on 2026-06-02
 * (granite-small, gpu) and are quoted per case. They are documentation, not
 * assertions — the harness recomputes them every run.
 *
 * Usage:
 *   npx tsx src/eval-seed.ts            # table output
 *   npx tsx src/eval-seed.ts --json     # machine-readable
 */

process.env.GMAX_WORKER_COUNT ??= "1";

import * as path from "node:path";
import { Searcher } from "./lib/search/searcher";
import type { SearchResponse } from "./lib/store/types";
import { VectorDB } from "./lib/store/vector-db";
import { gracefulExit } from "./lib/utils/exit";
import { PATHS } from "./config";

type SeedKind = "route" | "recover" | "guard";

interface SeedCase {
  id: string;
  /** Which indexed corpus to query (default "gmax"). */
  repo?: "gmax" | "express";
  /** Ambiguous NL query — matches several subsystems on purpose. */
  query: string;
  /** Agent's "open files" (paths relative to project root). */
  seedFiles?: string[];
  /** Agent's discussed identifiers. */
  seedSymbols?: string[];
  /** Path (suffix) of the contextually-correct answer file. */
  expectedFile: string;
  kind: SeedKind;
  /** Measured no-seed baseline rank of expectedFile (0 = out of top-K). */
  baselineRankNote: number;
  note?: string;
}

// Route/recover cases target the gmax repo itself — the corpus whose graph the
// author can verify by hand. The "idle timeout" concept lives in three
// subsystems (worker reap / LLM server / daemon); "health check" in three more.
// That natural polysemy is what makes the routing test honest.
//
// The no-harm guards instead target the immutable express fixture: querying
// gmax for "rank fusion" is contaminated by this harness's own source (which is
// full of "fusion" prose and gets live-indexed), so a stable external corpus is
// the honest place to assert "an irrelevant seed must not displace the winner".
const REPO_ROOTS: Record<NonNullable<SeedCase["repo"]>, string> = {
  gmax: path.join(process.env.HOME ?? "", "Development/beyond/tools/gmax"),
  express: path.join(process.env.HOME ?? "", "Development/sandbox/bench-fixtures/express"),
};

const GMAX_CASES: SeedCase[] = [
  // ── Triple A: "idle timeout shutdown" routes to worker / LLM / daemon ──────
  {
    id: "idle-pool",
    query: "idle timeout shutdown",
    seedFiles: ["src/lib/workers/pool.ts"],
    expectedFile: "src/lib/workers/pool.ts",
    kind: "guard", // already rank 1 without seeds — seeding must not demote it
    baselineRankNote: 1,
    note: "worker-reap is the no-seed winner; seeding its own file keeps it #1",
  },
  {
    id: "idle-llm",
    query: "idle timeout shutdown",
    seedFiles: ["src/lib/llm/server.ts"],
    expectedFile: "src/lib/llm/server.ts",
    kind: "route",
    baselineRankNote: 5,
    note: "LLM idle watchdog at #5 behind worker-reap chunks; seed should lift it to #1",
  },
  {
    id: "idle-daemon",
    query: "idle timeout shutdown",
    seedFiles: ["src/lib/daemon/daemon.ts"],
    expectedFile: "src/lib/daemon/daemon.ts",
    kind: "recover",
    baselineRankNote: 0,
    note: "daemon idle checker is OUT of the no-seed top-25; candidate-gen weight must recover it",
  },
  // ── Triple B: "health check probe" routes to doctor / mlx / llm ────────────
  {
    id: "health-doctor",
    query: "health check probe",
    seedFiles: ["src/commands/doctor.ts"],
    expectedFile: "src/commands/doctor.ts",
    kind: "guard",
    baselineRankNote: 1,
    note: "doctor is the no-seed winner; seeding its own file keeps it #1",
  },
  {
    id: "health-mlx",
    query: "health check probe",
    seedFiles: ["src/lib/workers/embeddings/mlx-client.ts"],
    expectedFile: "src/lib/workers/embeddings/mlx-client.ts",
    kind: "route",
    baselineRankNote: 3,
    note: "mlx checkHealth at #3; seed should lift the embed-server probe to #1",
  },
  {
    id: "health-llm",
    query: "health check probe",
    seedFiles: ["src/lib/llm/server.ts"],
    expectedFile: "src/lib/llm/server.ts",
    kind: "route",
    baselineRankNote: 5,
    note: "llm-server healthy() at #5; seed should lift it to #1",
  },
  // ── Symbol seeding: discussed identifier instead of open file ──────────────
  {
    id: "idle-llm-sym",
    query: "idle timeout shutdown",
    seedSymbols: ["LlmServer"],
    expectedFile: "src/lib/llm/server.ts",
    kind: "route",
    baselineRankNote: 5,
    note: "symbol-seed analog of idle-llm: discussing LlmServer biases toward its file",
  },
  // ── Guards: irrelevant seed must not perturb a strong no-seed winner.
  //    On the immutable express fixture so the assertion can't be polluted by
  //    live-indexing this harness's own source. ────────────────────────────────
  {
    id: "guard-express-file",
    repo: "express",
    query: "create the application factory",
    seedFiles: ["lib/view.js"],
    expectedFile: "lib/express.js",
    kind: "guard",
    baselineRankNote: 1,
    note: "view.js (rank ~150 for this query) is off-topic; express.js must stay #1",
  },
  {
    id: "guard-express-sym",
    repo: "express",
    query: "create the application factory",
    seedSymbols: ["View"],
    expectedFile: "lib/express.js",
    kind: "guard",
    baselineRankNote: 1,
    note: "View is defined in the off-topic view.js; express.js must stay #1",
  },
];

/** Rank (1-indexed) of the first result whose path matches expectedFile; 0 = miss. */
function rankOf(response: SearchResponse, expectedFile: string): number {
  const want = expectedFile.toLowerCase();
  const idx = response.data.findIndex((chunk) => {
    const p = String(chunk.metadata?.path || "").toLowerCase();
    return p.endsWith(`/${want}`) || p.endsWith(want);
  });
  return idx + 1;
}

interface SeedResult {
  id: string;
  kind: SeedKind;
  query: string;
  expectedFile: string;
  baselineRank: number;
  seededRank: number;
  /** Pass criterion met for this kind. */
  pass: boolean;
  note?: string;
}

function judge(kind: SeedKind, baseline: number, seeded: number): boolean {
  // 0 means "not found in top-K"; treat as worse than any found rank.
  const b = baseline === 0 ? Infinity : baseline;
  const s = seeded === 0 ? Infinity : seeded;
  switch (kind) {
    case "route":
      // Seeding must improve (or already hold) the contextually-correct file's
      // rank — and land it at the top.
      return s <= b && s === 1;
    case "recover":
      // Out-of-pool baseline must be pulled into the results and to the top.
      return baseline === 0 && s === 1;
    case "guard":
      // No harm: the file must not lose rank (and a rank-1 stays rank-1).
      return s <= b;
  }
}

async function run() {
  const jsonMode = process.argv.includes("--json") || process.env.GMAX_EVAL_JSON === "1";
  const topK = 25;
  const rerank = process.env.GMAX_EVAL_RERANK === "1";

  const vectorDb = new VectorDB(PATHS.lancedbDir);
  const searcher = new Searcher(vectorDb);

  const results: SeedResult[] = [];
  for (const c of GMAX_CASES) {
    const pathPrefix = `${REPO_ROOTS[c.repo ?? "gmax"]}/`;
    const baseRes = await searcher.search(c.query, topK, { rerank }, undefined, pathPrefix);
    const seededRes = await searcher.search(
      c.query,
      topK,
      { rerank, seeds: { files: c.seedFiles, symbols: c.seedSymbols } },
      undefined,
      pathPrefix,
    );
    const baselineRank = rankOf(baseRes, c.expectedFile);
    const seededRank = rankOf(seededRes, c.expectedFile);
    results.push({
      id: c.id,
      kind: c.kind,
      query: c.query,
      expectedFile: c.expectedFile,
      baselineRank,
      seededRank,
      pass: judge(c.kind, baselineRank, seededRank),
      note: c.note,
    });
  }

  await vectorDb.close();

  const passes = results.filter((r) => r.pass).length;
  const byKind = (k: SeedKind) => results.filter((r) => r.kind === k);
  const summary = {
    cases: results.length,
    passes,
    route: { total: byKind("route").length, pass: byKind("route").filter((r) => r.pass).length },
    recover: { total: byKind("recover").length, pass: byKind("recover").filter((r) => r.pass).length },
    guard: { total: byKind("guard").length, pass: byKind("guard").filter((r) => r.pass).length },
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ rerank, summary, results }, null, 2)}\n`);
  } else {
    console.log(`Seed eval (rerank=${rerank ? "on" : "off"})\n`);
    const fmtRank = (r: number) => (r === 0 ? "—" : `#${r}`);
    for (const r of results) {
      const arrow = `${fmtRank(r.baselineRank)} → ${fmtRank(r.seededRank)}`;
      const mark = r.pass ? "✓" : "✗";
      const seed = `[${r.kind}]`;
      console.log(`  ${mark} ${r.id.padEnd(18)} ${seed.padEnd(10)} ${arrow.padEnd(12)} ${r.expectedFile}`);
      if (r.note) console.log(`      ${r.note}`);
    }
    console.log(
      `\n  → ${passes}/${results.length} pass  ` +
        `(route ${summary.route.pass}/${summary.route.total}, ` +
        `recover ${summary.recover.pass}/${summary.recover.total}, ` +
        `guard ${summary.guard.pass}/${summary.guard.total})`,
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
