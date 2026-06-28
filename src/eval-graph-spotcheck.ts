/**
 * Pulls the chunks for a known BeyondError-using file out of the index
 * and prints their `referenced_symbols` arrays. Lets us see what the
 * chunker actually extracts vs what's missing — whether BeyondError is
 * absent due to chunker scope (e.g., only same-function refs are tagged)
 * or whether the tagging is just sparse.
 */

process.env.GMAX_WORKER_COUNT ??= "1";

import { PATHS } from "./config";
import { VectorDB } from "./lib/store/vector-db";
import { gracefulExit } from "./lib/utils/exit";
import { escapeSqlString } from "./lib/utils/filter-builder";

const CANDIDATES = [
  "/Users/reoiv/Development/beyond/platform/packages/api/src/middleware/error.ts",
  "/Users/reoiv/Development/beyond/platform/packages/api/src/graphql/shared/error-mapping.ts",
  "/Users/reoiv/Development/beyond/platform/packages/api/src/lib/service-errors.ts",
];

function toStrArr(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v))
    return v.filter((x): x is string => typeof x === "string");
  const m = v as { toArray?: () => unknown };
  if (typeof m.toArray === "function") {
    try {
      const a = m.toArray();
      return Array.isArray(a)
        ? a.filter((x): x is string => typeof x === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function main() {
  const db = new VectorDB(PATHS.lancedbDir);
  const table = await db.ensureTable();
  for (const file of CANDIDATES) {
    console.log(`\n── ${file}`);
    const rows = (await table
      .query()
      .select([
        "start_line",
        "end_line",
        "chunk_type",
        "defined_symbols",
        "referenced_symbols",
      ])
      .where(`path = '${escapeSqlString(file)}'`)
      .limit(20)
      .toArray()) as Record<string, unknown>[];
    if (rows.length === 0) {
      console.log("  (no chunks indexed for this path)");
      continue;
    }
    for (const r of rows) {
      const defs = toStrArr(r.defined_symbols);
      const refs = toStrArr(r.referenced_symbols);
      const hasBE = refs.includes("BeyondError");
      console.log(
        `  lines ${r.start_line}-${r.end_line} (${r.chunk_type})  ` +
          `defs=[${defs.slice(0, 4).join(",")}${defs.length > 4 ? "…" : ""}]  ` +
          `refs(${refs.length})=[${refs.slice(0, 8).join(",")}${refs.length > 8 ? "…" : ""}]  ` +
          `BeyondError-ref=${hasBE ? "✓" : "✗"}`,
      );
    }
  }
  await db.close();
  await gracefulExit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
