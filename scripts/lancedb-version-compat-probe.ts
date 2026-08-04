import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import type { VectorRecord } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";
import { pathStartsWith } from "../src/lib/utils/filter-builder";

const [storeDir, marker] = process.argv.slice(2);
if (!storeDir || !marker) {
  throw new Error("Usage: lancedb-version-compat-probe.ts <store-dir> <marker>");
}

const require = createRequire(import.meta.url);
const entry = require.resolve("@lancedb/lancedb");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(path.dirname(entry), "..", "package.json"), "utf8"),
) as { version: string };

function record(): VectorRecord {
  return {
    id: marker,
    path: `/compat/${marker}.ts`,
    hash: `hash-${marker}`,
    content: `compatibility marker ${marker}`,
    start_line: 1,
    end_line: 1,
    vector: [1, 0, 0, 0],
    colbert: [],
    colbert_scale: 1,
    pooled_colbert_48d: new Array(48).fill(0),
    doc_token_ids: [],
  };
}

async function main(): Promise<void> {
  const db = new VectorDB(storeDir, 4);
  try {
    await db.insertBatch([record()]);
    await db.createFTSIndex();
    let table = await db.ensureTable();
    const fts = await table
      .search("compatibility")
      .select(["id", "_score"])
      .where(pathStartsWith("/compat/"))
      .toArray();
    const vector = await table
      .vectorSearch([1, 0, 0, 0])
      .column("vector")
      .bypassVectorIndex()
      .select(["id", "_distance"])
      .where(pathStartsWith("/compat/"))
      .limit(100)
      .toArray();
    await db.updateRows([marker], "summary", [`updated-by-${packageJson.version}`]);
    await db.optimize(1, 0, true);
    await db.close();

    const reopened = new VectorDB(storeDir, 4);
    table = await reopened.ensureTable();
    const rows = await table
      .query()
      .select(["id", "summary"])
      .where(pathStartsWith("/compat/"))
      .toArray();
    await reopened.close();
    console.log(
      JSON.stringify({
        version: packageJson.version,
        rows: rows.sort((a, b) => String(a.id).localeCompare(String(b.id))),
        ftsIds: fts.map((row) => String(row.id)).sort(),
        vectorIds: vector.map((row) => String(row.id)).sort(),
      }),
    );
  } finally {
    await db.close();
  }
}

void main();
