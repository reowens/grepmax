import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VectorRecord } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";
import { pathStartsWith } from "../src/lib/utils/filter-builder";

function record(
  id: string,
  filePath: string,
  content: string,
  vector: number[],
): VectorRecord {
  return {
    id,
    path: filePath,
    hash: `hash-${id}`,
    content,
    start_line: 1,
    end_line: 1,
    vector,
    colbert: [],
    colbert_scale: 1,
    pooled_colbert_48d: new Array(48).fill(0),
    doc_token_ids: [],
  };
}

describe("LanceDB 0.31 real-store compatibility", () => {
  let dir: string;
  let db: VectorDB;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-lancedb-031-"));
    db = new VectorDB(dir, 4);
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves FTS, exact-vector, filter, index, mutation, and reopen contracts", async () => {
    await db.insertBatch([
      record("app-alpha", "/repo/app/alpha.ts", "alpha service", [1, 0, 0, 0]),
      record("app-beta", "/repo/app/beta.ts", "beta service", [0, 1, 0, 0]),
      record(
        "app2-alpha",
        "/repo/app2/alpha.ts",
        "alpha sibling",
        [0.9, 0.1, 0, 0],
      ),
    ]);
    await db.createFTSIndex();

    let table = await db.ensureTable();
    await table.createIndex("path", {
      config: lancedb.Index.btree(),
      name: "path_idx",
      replace: true,
    });
    await table.createIndex("vector", {
      config: lancedb.Index.ivfFlat({ distanceType: "l2", numPartitions: 1 }),
      name: "vector_idx",
      replace: true,
    });
    const scopedFts = await table
      .search("alpha")
      .select(["id", "path", "_score"])
      .where(pathStartsWith("/repo/app/"))
      .toArray();
    expect(scopedFts.map((row) => row.id)).toEqual(["app-alpha"]);

    const exact = await table
      .vectorSearch([1, 0, 0, 0])
      .column("vector")
      .bypassVectorIndex()
      .select(["id", "path", "_distance"])
      .where(pathStartsWith("/repo/app/"))
      .limit(2)
      .toArray();
    expect(exact.map((row) => row.id)).toEqual(["app-alpha", "app-beta"]);

    const repeatedWhere = await table
      .query()
      .select(["id"])
      .where(pathStartsWith("/repo/app/"))
      .where("id = 'app-beta'")
      .toArray();
    expect(repeatedWhere.map((row) => row.id)).toEqual(["app-beta"]);

    const indices = await table.listIndices();
    const fts = indices.find((index) => index.columns.includes("content"));
    expect(indices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "path_idx", columns: ["path"] }),
        expect.objectContaining({ name: "vector_idx", columns: ["vector"] }),
      ]),
    );
    expect(fts).toBeDefined();
    const ftsStats = await table.indexStats(fts!.name);
    if (!ftsStats) throw new Error("Expected FTS index statistics");
    expect(ftsStats.numIndexedRows).toBe(3);
    expect(ftsStats.numUnindexedRows).toBe(0);

    const beforeVersion = await table.version();
    expect((await table.listVersions()).length).toBeGreaterThan(0);
    const stats = await table.stats();
    expect(stats.fragmentStats.numFragments).toBeGreaterThan(0);

    await db.updateRows(["app-beta"], "summary", ["updated"]);
    await db.deletePaths(["/repo/app2/alpha.ts"]);
    expect(await db.countRowsForPath("/repo/app")).toBe(2);
    expect(await db.countRowsForPath("/repo/app2")).toBe(0);
    // Lance table handles are snapshots; reopening observes commits made by
    // VectorDB methods through their own handles.
    expect(await table.version()).toBe(beforeVersion);
    table = await db.ensureTable();
    expect(await table.version()).toBeGreaterThan(beforeVersion);

    await db.optimize(1, 0, true);
    await db.optimize(1, 0, true);
    await db.close();

    db = new VectorDB(dir, 4);
    table = await db.ensureTable();
    expect(await table.countRows()).toBe(2);
    expect(await db.getSchemaVectorDim()).toBe(4);
    const reopened = await table
      .query()
      .select(["id", "summary"])
      .where("id = 'app-beta'")
      .toArray();
    expect(reopened).toMatchObject([{ id: "app-beta", summary: "updated" }]);
  });
});
