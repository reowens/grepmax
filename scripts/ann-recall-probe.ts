import * as path from "node:path";
import { PATHS } from "../src/config";
import { cases } from "../src/eval";
import { VectorDB } from "../src/lib/store/vector-db";
import { pathStartsWith } from "../src/lib/utils/filter-builder";
import { getWorkerPool } from "../src/lib/workers/pool";

const K = 500;
const queries = cases.slice(0, 50).map((entry) => entry.query);
const baselineOnly = process.argv.includes("--baseline");
const projectRoot = path.resolve(process.cwd());
const scopes = [
  { name: "unscoped", where: undefined },
  { name: "scoped", where: pathStartsWith(`${projectRoot}/`) },
];

async function idsFor(
  table: Awaited<ReturnType<VectorDB["ensureTable"]>>,
  dense: number[],
  where: string | undefined,
  exact: boolean,
): Promise<{ ids: string[]; elapsedMs: number }> {
  let query = table
    .vectorSearch(dense)
    .column("vector")
    .select(["id", "_distance"])
    .limit(K);
  if (where) query = query.where(where);
  if (exact) query = query.bypassVectorIndex();
  else query = query.minimumNprobes(20).maximumNprobes(200);
  const started = performance.now();
  const rows = await query.toArray();
  return {
    ids: rows.map((row) => String(row.id)),
    elapsedMs: performance.now() - started,
  };
}

async function run(): Promise<void> {
  const db = new VectorDB(PATHS.lancedbDir);
  const pool = getWorkerPool();
  try {
    const table = await db.ensureTable();
    const summaries = [];
    for (const scope of scopes) {
      const overlaps: number[] = [];
      const exactTimes: number[] = [];
      const annTimes: number[] = [];
      for (const text of queries) {
        const encoded = await pool.encodeQuery(text);
        const exact = await idsFor(table, encoded.dense, scope.where, true);
        exactTimes.push(exact.elapsedMs);
        if (!baselineOnly) {
          const ann = await idsFor(table, encoded.dense, scope.where, false);
          annTimes.push(ann.elapsedMs);
          const exactSet = new Set(exact.ids);
          const shared = ann.ids.filter((id) => exactSet.has(id)).length;
          overlaps.push(shared / Math.max(1, exact.ids.length));
        }
      }
      summaries.push({
        scope: scope.name,
        queries: queries.length,
        meanOverlap:
          overlaps.length > 0
            ? overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length
            : undefined,
        minOverlap: overlaps.length > 0 ? Math.min(...overlaps) : undefined,
        exactAvgMs:
          exactTimes.reduce((sum, value) => sum + value, 0) /
          exactTimes.length,
        annAvgMs:
          annTimes.length > 0
            ? annTimes.reduce((sum, value) => sum + value, 0) / annTimes.length
            : undefined,
      });
    }
    console.log(JSON.stringify({ mode: baselineOnly ? "baseline" : "compare", summaries }, null, 2));
  } finally {
    await pool.destroy();
    await db.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
