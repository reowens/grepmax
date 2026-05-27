/**
 * Phase 0 sanity check for Bundle B G1' (graph-as-recall-recovery).
 *
 * For each platform hard-miss case (BeyondError, ErrorCodes, resolveActor,
 * errorHandler), mirror the searcher's dense+FTS+RRF pipeline to produce
 * the post-fusion top-200 candidate pool, then count how many of those
 * 200 chunks have `referenced_symbols` containing the target symbol.
 *
 * ≥1 hit per case = 1-hop outbound graph walk can recover the target
 * (the seed chunk's defined symbol points at the target via the call
 * graph) → worth building the recovery layer.
 *
 * 0 hits across all 4 = the signal isn't in the graph at this seed
 * depth → stop and report the negative result.
 *
 * Run: `npx tsx src/eval-graph-sanity.ts`
 */

process.env.GMAX_WORKER_COUNT ??= "1";

import * as path from "node:path";
import { PATHS } from "./config";
import { VectorDB } from "./lib/store/vector-db";
import { gracefulExit } from "./lib/utils/exit";
import { getWorkerPool } from "./lib/workers/pool";
import { escapeSqlString } from "./lib/utils/filter-builder";

const PLATFORM_ROOT = path.join(
  process.env.HOME ?? "",
  "Development/beyond/platform",
);

const HARD_MISS_TARGETS = [
  "BeyondError",
  "ErrorCodes",
  "resolveActor",
  "errorHandler",
];

const PRE_K = 500;
const STAGE1_K = 200;
const RRF_K = 60;

function toStringArray(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.filter((v): v is string => typeof v === "string");
  }
  const maybe = val as { toArray?: () => unknown };
  if (typeof maybe.toArray === "function") {
    try {
      const arr = maybe.toArray();
      return Array.isArray(arr)
        ? arr.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function probe(target: string) {
  const db = new VectorDB(PATHS.lancedbDir);
  const table = await db.ensureTable();
  const pool = getWorkerPool();
  const { dense } = await pool.encodeQuery(target);

  const pathPrefix = PLATFORM_ROOT.endsWith("/") ? PLATFORM_ROOT : `${PLATFORM_ROOT}/`;
  const where = `path LIKE '${escapeSqlString(pathPrefix)}%'`;

  const columns = [
    "id",
    "path",
    "chunk_index",
    "start_line",
    "end_line",
    "defined_symbols",
    "referenced_symbols",
  ];

  const vectorRows = (await table
    .vectorSearch(dense)
    .select([...columns, "_distance"])
    .where(where)
    .limit(PRE_K)
    .toArray()) as Record<string, unknown>[];

  let ftsRows: Record<string, unknown>[] = [];
  try {
    ftsRows = (await table
      .search(target)
      .select([...columns, "_score"])
      .where(where)
      .limit(PRE_K)
      .toArray()) as Record<string, unknown>[];
  } catch (e) {
    console.warn(`[sanity] FTS unavailable for "${target}": ${(e as Error).message}`);
  }

  const candidateScores = new Map<string, number>();
  const docMap = new Map<string, Record<string, unknown>>();

  vectorRows.forEach((doc, rank) => {
    const key =
      (doc.id as string | undefined) ||
      `${doc.path}:${doc.chunk_index}`;
    docMap.set(key, doc);
    candidateScores.set(
      key,
      (candidateScores.get(key) || 0) + 1.0 / (RRF_K + rank + 1),
    );
  });
  ftsRows.forEach((doc, rank) => {
    const key =
      (doc.id as string | undefined) ||
      `${doc.path}:${doc.chunk_index}`;
    if (!docMap.has(key)) docMap.set(key, doc);
    candidateScores.set(
      key,
      (candidateScores.get(key) || 0) + 1.0 / (RRF_K + rank + 1),
    );
  });

  const fused = Array.from(candidateScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, STAGE1_K)
    .map(([key]) => docMap.get(key)!)
    .filter(Boolean);

  let withRef = 0;
  let withDef = 0;
  let rankOfFirstRef = -1;
  let rankOfFirstDef = -1;
  const sampleRefHits: Array<{ rank: number; path: string }> = [];
  fused.forEach((doc, i) => {
    const refs = toStringArray(doc.referenced_symbols);
    const defs = toStringArray(doc.defined_symbols);
    if (refs.includes(target)) {
      withRef++;
      if (rankOfFirstRef < 0) rankOfFirstRef = i + 1;
      if (sampleRefHits.length < 3) {
        sampleRefHits.push({ rank: i + 1, path: String(doc.path) });
      }
    }
    if (defs.includes(target)) {
      withDef++;
      if (rankOfFirstDef < 0) rankOfFirstDef = i + 1;
    }
  });

  await db.close();

  return {
    target,
    poolSize: fused.length,
    vectorRows: vectorRows.length,
    ftsRows: ftsRows.length,
    withRef,
    withDef,
    rankOfFirstRef,
    rankOfFirstDef,
    sampleRefHits,
  };
}

async function main() {
  console.log(`Phase 0 sanity check — graph reachability on platform hard-miss cases`);
  console.log(`pathPrefix: ${PLATFORM_ROOT}`);
  console.log(`STAGE1_K=${STAGE1_K}, PRE_K=${PRE_K}\n`);

  let anyReachable = false;
  const summary: Array<Awaited<ReturnType<typeof probe>>> = [];
  for (const target of HARD_MISS_TARGETS) {
    const res = await probe(target);
    summary.push(res);
    const refOK = res.withRef > 0 ? "✓" : "✗";
    const defOK = res.withDef > 0 ? "✓" : "✗";
    console.log(
      `${refOK} ${target.padEnd(16)} pool=${String(res.poolSize).padStart(3)}  ` +
      `refs=${String(res.withRef).padStart(3)}/200  defs=${defOK} (${res.withDef})  ` +
      `1st-ref@${res.rankOfFirstRef > 0 ? res.rankOfFirstRef : "—"}  ` +
      `1st-def@${res.rankOfFirstDef > 0 ? res.rankOfFirstDef : "—"}`,
    );
    for (const s of res.sampleRefHits) {
      console.log(`    ↳ rank ${s.rank}: ${s.path}`);
    }
    if (res.withRef > 0) anyReachable = true;
  }

  console.log(`\nVerdict: ${anyReachable ? "BUILD (≥1 case has graph signal in top-200)" : "ABORT (graph is empty at this depth — pick a different mechanism)"}`);

  console.log(`\nJSON:`);
  console.log(JSON.stringify(summary, null, 2));

  await gracefulExit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
