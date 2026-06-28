/**
 * Diagnostic counterpart to eval-graph-sanity.ts.
 *
 * Phase 0 found that 0/200 fusion-pool chunks reference any of the 4
 * hard-miss targets via `referenced_symbols`. That can mean either:
 *   (a) chunker isn't extracting these refs (upstream miss), OR
 *   (b) refs exist but live outside the fusion top-200.
 *
 * This script measures the *total* `array_contains(referenced_symbols, X)`
 * count across the whole platform index for each target. If those counts
 * are also ~0, the graph is empty at the data-extraction layer, not the
 * retrieval layer.
 */

process.env.GMAX_WORKER_COUNT ??= "1";

import * as path from "node:path";
import { PATHS } from "./config";
import { VectorDB } from "./lib/store/vector-db";
import { gracefulExit } from "./lib/utils/exit";
import { escapeSqlString } from "./lib/utils/filter-builder";

const PLATFORM_ROOT = path.join(
  process.env.HOME ?? "",
  "Development/beyond/platform",
);

const TARGETS = ["BeyondError", "ErrorCodes", "resolveActor", "errorHandler"];

async function main() {
  const db = new VectorDB(PATHS.lancedbDir);
  const table = await db.ensureTable();
  const pathPrefix = PLATFORM_ROOT.endsWith("/")
    ? PLATFORM_ROOT
    : `${PLATFORM_ROOT}/`;
  const scope = `path LIKE '${escapeSqlString(pathPrefix)}%'`;

  console.log(`Platform graph density check — pathPrefix=${PLATFORM_ROOT}\n`);

  for (const sym of TARGETS) {
    const esc = escapeSqlString(sym);
    const refRows = await table
      .query()
      .select(["path"])
      .where(`${scope} AND array_contains(referenced_symbols, '${esc}')`)
      .limit(2000)
      .toArray();
    const defRows = await table
      .query()
      .select(["path"])
      .where(`${scope} AND array_contains(defined_symbols, '${esc}')`)
      .limit(2000)
      .toArray();
    console.log(
      `${sym.padEnd(16)}  def-chunks=${String(defRows.length).padStart(3)}  ref-chunks=${String(refRows.length).padStart(4)}`,
    );
  }

  // Also count chunks with non-empty referenced_symbols overall to baseline
  // graph density.
  const allRows = await table
    .query()
    .select(["referenced_symbols"])
    .where(scope)
    .limit(20000)
    .toArray();
  let nonEmpty = 0;
  let totalRefs = 0;
  for (const row of allRows) {
    const raw = (row as { referenced_symbols?: unknown }).referenced_symbols;
    let arr: string[] = [];
    if (Array.isArray(raw))
      arr = raw.filter((v): v is string => typeof v === "string");
    else if (
      raw &&
      typeof (raw as { toArray?: () => unknown }).toArray === "function"
    ) {
      try {
        const a = (raw as { toArray: () => unknown }).toArray();
        if (Array.isArray(a))
          arr = a.filter((v): v is string => typeof v === "string");
      } catch {}
    }
    if (arr.length > 0) {
      nonEmpty++;
      totalRefs += arr.length;
    }
  }
  console.log(
    `\nPlatform corpus: ${allRows.length} chunks sampled (cap 20k), ` +
      `${nonEmpty} with non-empty referenced_symbols (${((nonEmpty / allRows.length) * 100).toFixed(1)}%), ` +
      `avg refs/chunk = ${(totalRefs / Math.max(1, nonEmpty)).toFixed(1)}`,
  );

  await db.close();
  await gracefulExit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
