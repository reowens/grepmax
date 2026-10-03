import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { GraphBuilder } from "../src/lib/graph/graph-builder";
import { VectorDB } from "../src/lib/store/vector-db";
import {
  QUERY_EXECUTION_OPTIONS,
  streamQueryRows,
} from "../src/lib/utils/query-timeout";

it("LIKE+limit completes and streaming preserves all distinct paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-query-bounds-"));
  const db = new VectorDB(dir, 384);
  try {
    const seed = (db as any).seedRow();
    // Several batches, duplicate paths, a wildcard/quote root and another root.
    const prefix = "/fixture/a%'_/";
    await db.insertBatch(
      Array.from({ length: 1_100 }, (_, i) => ({
        ...seed,
        id: `row-${i}`,
        path: i === 1099 ? "/other/b.ts" : `${prefix}${i % 151}.ts`,
        content: "import { Fixture } from './fixture'",
      })),
    );
    const table = await db.ensureTable();
    const limited = await table
      .query()
      .select(["path"])
      .where("content LIKE '%Fixture%'")
      .limit(7)
      .toArray(QUERY_EXECUTION_OPTIONS);
    expect(limited).toHaveLength(7);
    expect((await db.getDistinctPathsForPrefix(prefix)).size).toBe(151);
    expect(await db.getDistinctFileCount()).toBe(152);
    const importers = await new GraphBuilder(db).getImporters("Fixture");
    expect(importers).toHaveLength(100);
    // Early stream termination must leave the connection usable.
    let count = 0;
    for await (const _row of streamQueryRows(
      table.query().select(["path"]),
      "early stop",
    )) {
      count++;
      break;
    }
    expect(count).toBe(1);
    expect(await db.hasAnyRows()).toBe(true);
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
