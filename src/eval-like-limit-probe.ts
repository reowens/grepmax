/**
 * Regression probe for the @lancedb 0.27.x LIKE + limit deadlock.
 *
 * A `content LIKE '%X%'` scan with `.limit(N)` never resolves when more than
 * N rows match — the limit-pushdown cancellation loses the completion (same
 * family as lancedb/lancedb#2189). gmax works around it by scanning without a
 * limit and capping in JS; this probe tells us when an upstream lancedb
 * upgrade makes the limited shape safe again (so the workaround can go).
 *
 * Exit 0 = limited LIKE scan resolved (upstream fixed, or matches < limit).
 * Exit 1 = timed out — the deadlock is still present, keep the workarounds.
 *
 * Run: `npx tsx src/eval-like-limit-probe.ts [needle]` (default: "Daemon",
 * which matches >100 chunks in this repo's index).
 */

import { PATHS } from "./config";
import { VectorDB } from "./lib/store/vector-db";
import { escapeSqlString } from "./lib/utils/filter-builder";
import { withQueryTimeout } from "./lib/utils/query-timeout";

const needle = process.argv[2] || "Daemon";
const TIMEOUT_MS = 10_000;

async function main() {
  const db = new VectorDB(PATHS.lancedbDir);
  const table = await db.ensureTable();
  const where = `content LIKE '%${escapeSqlString(needle)}%'`;

  const all = await withQueryTimeout(
    table.query().select(["path"]).where(where).toArray(),
    "unlimited LIKE scan",
    TIMEOUT_MS,
  );
  console.log(`unlimited scan: ${all.length} matches for '%${needle}%'`);
  if (all.length < 2) {
    console.log("needle too rare to exercise the bug — pick a common one");
    process.exit(0);
  }

  const limit = Math.max(1, Math.floor(all.length / 2));
  const t0 = Date.now();
  try {
    const rows = await withQueryTimeout(
      table.query().select(["path"]).where(where).limit(limit).toArray(),
      `LIKE scan with limit ${limit} < ${all.length} matches`,
      TIMEOUT_MS,
    );
    console.log(
      `limited scan OK: ${rows.length} rows in ${Date.now() - t0}ms — ` +
        `upstream deadlock not reproduced; LIKE+limit workarounds may be removable`,
    );
    process.exit(0);
  } catch (err) {
    console.error(String(err));
    console.error(
      "LIKE+limit deadlock still present — keep the unlimited-scan workarounds",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
