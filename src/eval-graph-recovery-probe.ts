/**
 * Phase 3 design probe. For each platform symbol-name miss, determine whether
 * the expected DEFINITION chunk is:
 *   (a) inside the top-200 fusion pool but lost downstream  -> a ranking fix
 *   (b) outside the pool (but inside the 500-row retrieval)  -> recovery fix
 *   (c) outside retrieval entirely                            -> unreachable
 * and whether a 1-hop ref->def walk from the top-K fusion seeds reaches it
 * (i.e. some seed's referenced_symbols contains the query symbol).
 *
 * Run: npx tsx src/eval-graph-recovery-probe.ts
 */

process.env.GMAX_WORKER_COUNT ??= "1";

import * as path from "node:path";
import { PATHS } from "./config";
import { VectorDB } from "./lib/store/vector-db";
import { gracefulExit } from "./lib/utils/exit";
import { getWorkerPool } from "./lib/workers/pool";
import { escapeSqlString } from "./lib/utils/filter-builder";

const PLATFORM_ROOT = path.join(process.env.HOME ?? "", "Development/beyond/platform");
const PRE_K = 500;
const STAGE1_K = 200;
const SEED_K = 20;
const RRF_K = 60;

// (query symbol, expected definition file) — the rank-0 platform misses.
const CASES: Array<[string, string]> = [
  ["BeyondError", "packages/shared/src/errors.ts"],
  ["ErrorCodes", "packages/shared/src/errors.ts"],
  ["createDb", "packages/db/src/index.ts"],
  ["createDbAsync", "packages/db/src/index.ts"],
  ["authMiddleware", "packages/api/src/middleware/auth.ts"],
  ["requireAuth", "packages/api/src/middleware/auth.ts"],
  ["resolveActor", "packages/api/src/middleware/auth.ts"],
  ["getActor", "packages/api/src/middleware/auth.ts"],
  ["errorHandler", "packages/api/src/middleware/error.ts"],
  ["initializeApp", "packages/api/src/app.ts"],
];

function toStrArr(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
  const m = val as { toArray?: () => unknown };
  if (typeof m.toArray === "function") {
    try {
      const a = m.toArray();
      return Array.isArray(a) ? a.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function probe(table: any, sym: string, expectedFile: string) {
  const pool = getWorkerPool();
  const { dense } = await pool.encodeQuery(sym);
  const prefix = PLATFORM_ROOT.endsWith("/") ? PLATFORM_ROOT : `${PLATFORM_ROOT}/`;
  const where = `path LIKE '${escapeSqlString(prefix)}%'`;
  const columns = ["id", "path", "chunk_index", "defined_symbols", "referenced_symbols"];

  const vectorRows = (await table.vectorSearch(dense).select([...columns, "_distance"]).where(where).limit(PRE_K).toArray()) as any[];
  let ftsRows: any[] = [];
  try {
    ftsRows = (await table.search(sym).select([...columns, "_score"]).where(where).limit(PRE_K).toArray()) as any[];
  } catch {}

  const scores = new Map<string, number>();
  const docMap = new Map<string, any>();
  const keyOf = (d: any) => (d.id as string) || `${d.path}:${d.chunk_index}`;
  vectorRows.forEach((d, r) => { const k = keyOf(d); docMap.set(k, d); scores.set(k, (scores.get(k) || 0) + 1 / (RRF_K + r + 1)); });
  ftsRows.forEach((d, r) => { const k = keyOf(d); if (!docMap.has(k)) docMap.set(k, d); scores.set(k, (scores.get(k) || 0) + 1 / (RRF_K + r + 1)); });

  const fusedKeys = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const fused = fusedKeys.map((k) => docMap.get(k));

  // Locate the expected definition chunk among retrieved rows.
  const isExpected = (d: any) =>
    String(d.path).toLowerCase().endsWith(`/${expectedFile.toLowerCase()}`) &&
    toStrArr(d.defined_symbols).includes(sym);

  let defRetrievalRank = -1; // rank within full union (by fusion order)
  let defInPool = false;
  fused.forEach((d, i) => {
    if (defRetrievalRank < 0 && isExpected(d)) {
      defRetrievalRank = i + 1;
      defInPool = i < STAGE1_K;
    }
  });

  // Was the def chunk retrieved at all (in the 500 union) even if low?
  const defInUnion = fused.some(isExpected);

  // If not in the union, query directly to confirm it exists in the index.
  let defExistsInIndex = defInUnion;
  if (!defInUnion) {
    const direct = (await table.query().select(columns).where(`${where} AND array_contains(defined_symbols, '${escapeSqlString(sym)}')`).limit(50).toArray()) as any[];
    defExistsInIndex = direct.some((d) => String(d.path).toLowerCase().endsWith(`/${expectedFile.toLowerCase()}`));
  }

  // ref->def reachability: among top-SEED_K fusion seeds, how many reference `sym`?
  const seeds = fused.slice(0, SEED_K);
  let seedsRefSym = 0;
  let firstRefSeedRank = -1;
  seeds.forEach((d, i) => {
    if (toStrArr(d.referenced_symbols).includes(sym)) {
      seedsRefSym++;
      if (firstRefSeedRank < 0) firstRefSeedRank = i + 1;
    }
  });

  const loc = defRetrievalRank > 0
    ? (defInPool ? `pool#${defRetrievalRank}` : `union#${defRetrievalRank}(>200)`)
    : (defExistsInIndex ? "OUTSIDE-500" : "NOT-IN-INDEX?");

  return { sym, expectedFile, loc, seedsRefSym, firstRefSeedRank };
}

async function main() {
  const db = new VectorDB(PATHS.lancedbDir);
  const table = await db.ensureTable();
  console.log("sym             expectedDefChunk         seeds_ref  firstRefSeed");
  for (const [sym, file] of CASES) {
    const r = await probe(table, sym, file);
    console.log(
      `${r.sym.padEnd(15)} ${r.loc.padEnd(24)} ${String(r.seedsRefSym).padStart(3)}/20    ${r.firstRefSeedRank > 0 ? `rank${r.firstRefSeedRank}` : "-"}`,
    );
  }
  await db.close();
  await gracefulExit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
