import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VectorRecord } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";
import { pathStartsWith } from "../src/lib/utils/filter-builder";

// Historical native algorithm coverage only; production policy has no override.
vi.mock("../src/lib/store/maintenance-policy", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/lib/store/maintenance-policy")
    >();
  return {
    ...original,
    assertStoreMutationAllowed: () => {},
    storeMutationDeniedReason: () => null,
    fullTableMaintenanceDisabled: () => false,
    recordMaintenanceContainment: () =>
      "test-only historical algorithm fixture",
  };
});

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

describe("Pinned LanceDB native-store compatibility", () => {
  let dir: string;
  let db: VectorDB;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-lancedb-native-"));
    db = new VectorDB(dir, 4);
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reclaims reservation snapshots after each rewrite without rewriting again", async () => {
    const dataDir = path.join(dir, "chunks.lance", "data");
    for (let batch = 0; batch < 3; batch++) {
      await db.insertBatch(
        Array.from({ length: 100 }, (_, offset) => {
          const id = `${batch}-${offset}`;
          return record(
            id,
            `/repo/${id}.ts`,
            `retention fixture ${"abcdef ".repeat(1000)}`,
            [1, 0, 0, 0],
          );
        }),
      );
    }
    await db.createFTSIndex();
    for (let pass = 0; pass < 3; pass++) {
      if (pass > 0)
        await db.insertBatch([
          record(
            `later-${pass}`,
            `/repo/later-${pass}.ts`,
            "retention fixture later",
            [1, 0, 0, 0],
          ),
        ]);
      // Keep every fragment covered by the same FTS index so each pass really
      // rewrites to one fragment, rather than preserving distinct index groups.
      if (pass > 0) await db.createFTSIndex(true);
      const result = await db.optimize(1, 0, true);
      expect(result.status).toBe("completed");
      const table = await db.ensureTable();
      const currentVersion = await table.version();
      const current = (await table.listVersions()).find(
        (version) => version.version === currentVersion,
      );
      if (!current)
        throw new Error("Expected current native manifest metadata");
      const files = fs
        .readdirSync(dataDir)
        .filter((file) => file.endsWith(".lance"));
      expect(files).toHaveLength(Number(current.metadata.total_data_files));
      expect(
        files.reduce(
          (sum, file) => sum + fs.statSync(path.join(dataDir, file)).size,
          0,
        ),
      ).toBe(Number(current.metadata.total_files_size));
      expect(await table.countRows()).toBe(300 + pass);
      expect(
        await table
          .search("retention")
          .select(["id", "_score"])
          .limit(1000)
          .toArray(),
      ).toHaveLength(300 + pass);
      if (pass === 0) expect(result.cleanupPasses).toBe(1);
    }
  });

  it("passes the exact cleanup cutoff to the native binding", async () => {
    await db.insertBatch([
      record("keep", "/repo/keep.ts", "keep service", [1, 0, 0, 0]),
    ]);
    const table = await db.ensureTable();
    const optimize = vi
      .spyOn((table as any).inner, "optimize")
      .mockResolvedValue({
        compaction: {
          filesAdded: 0,
          filesRemoved: 0,
          fragmentsAdded: 0,
          fragmentsRemoved: 0,
        },
        prune: { bytesRemoved: 0, oldVersionsRemoved: 0 },
      });
    const cutoff = new Date("2020-01-02T03:04:05.678Z");
    try {
      await table.optimize({
        cleanupOlderThan: cutoff,
        deleteUnverified: true,
      });
      expect(optimize).toHaveBeenCalledWith(cutoff.getTime(), true);
    } finally {
      optimize.mockRestore();
    }
  });

  it("retains commits newer than the cutoff through native compaction", async () => {
    await db.insertBatch([
      record("first", "/repo/first.ts", "first service", [1, 0, 0, 0]),
    ]);
    const first = await (await db.ensureTable()).version();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cutoff = new Date();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await db.insertBatch([
      record("second", "/repo/second.ts", "second service", [0, 1, 0, 0]),
    ]);
    const retained = await (await db.ensureTable()).version();
    await db.insertBatch([
      record("third", "/repo/third.ts", "third service", [0, 0, 1, 0]),
    ]);
    const table = await db.ensureTable();
    const stats = await table.optimize({
      cleanupOlderThan: cutoff,
      deleteUnverified: true,
    });
    expect(stats.compaction.fragmentsRemoved).toBeGreaterThan(0);
    expect(stats.prune.oldVersionsRemoved).toBeGreaterThan(0);
    const versions = (await table.listVersions()).map(
      (version) => version.version,
    );
    expect(versions).not.toContain(first);
    expect(versions).toContain(retained);
    await table.checkout(retained);
    expect(await table.countRows()).toBe(2);
    await table.checkoutLatest();
    expect(await table.countRows()).toBe(3);
  });

  it("removes five unreferenced fragment copies while preserving current rows and FTS", async () => {
    await db.insertBatch([
      record("keep", "/repo/keep.ts", "retained service", [1, 0, 0, 0]),
    ]);
    await db.insertBatch([
      record("also-keep", "/repo/also.ts", "retained helper", [0, 1, 0, 0]),
    ]);
    await db.createFTSIndex();
    const dataDir = path.join(dir, "chunks.lance", "data");
    const fragment = fs
      .readdirSync(dataDir)
      .find((file) => file.endsWith(".lance"));
    if (!fragment) throw new Error("Expected a native Lance fragment");
    // Stage valid, unreferenced copies in this isolated store. This reproduces
    // the cleanup input, without forcing failed rewrites of the live index.
    const copies = Array.from({ length: 5 }, () =>
      path.join(dataDir, `${randomUUID()}.lance`),
    );
    for (const copy of copies)
      fs.copyFileSync(path.join(dataDir, fragment), copy);
    const copyBytes = copies.reduce(
      (sum, file) => sum + fs.statSync(file).size,
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await db.optimize(1, 0, true);
    expect(result.status).toBe("completed");
    expect(result.bytesReclaimed).toBeGreaterThanOrEqual(copyBytes);
    for (const copy of copies) expect(fs.existsSync(copy)).toBe(false);
    await db.close();
    db = new VectorDB(dir, 4);
    const table = await db.ensureTable();
    expect(await table.countRows()).toBe(2);
    const rows = await table
      .search("retained")
      .select(["id", "_score"])
      .toArray();
    expect(rows.map((row) => row.id).sort()).toEqual(["also-keep", "keep"]);
  });

  it("compacts from the committed native snapshot after a pending delete", async () => {
    await db.insertBatch([
      record("keep", "/repo/keep.ts", "keep service", [1, 0, 0, 0]),
      record("remove", "/repo/remove.ts", "remove service", [0, 1, 0, 0]),
    ]);
    const before = await (await db.ensureTable()).version();
    let finishDelete!: () => void;
    const pendingDelete = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    const write = (db as any).withWriteGate(async () => {
      await pendingDelete;
      const table = await (db as any).openExistingTableUnsafe();
      await table.delete("id = 'remove'");
      (db as any).markWriteCommitted();
    });
    const open = (db as any).ensureTableUnsafe.bind(db);
    const snapshots: number[] = [];
    vi.spyOn(db as any, "ensureTableUnsafe").mockImplementation(async () => {
      const table = await open();
      snapshots.push(await table.version());
      return table;
    });

    const optimize = db.optimize(1);
    // Allow the old implementation to open its stale native handle, so this
    // regression checks the actual Lance snapshot behavior as well as the gate.
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishDelete();
    await Promise.all([write, optimize]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toBeGreaterThan(before);
    expect((db as any).lastOptimizeDidWork).toBe(true);
    await db.close();
    db = new VectorDB(dir, 4);
    const rows = await (await db.ensureTable())
      .query()
      .select(["id"])
      .toArray();
    expect(rows.map((row) => row.id)).toEqual(["keep"]);
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
