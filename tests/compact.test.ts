import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Binary,
  Field,
  FixedSizeList,
  Float32,
  Int32,
  List,
  Schema,
  Utf8,
} from "apache-arrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactStore } from "../src/lib/store/compact";
import * as lancedb from "../src/lib/store/lance-sdk";
import { fullTableMaintenanceDisabled } from "../src/lib/store/maintenance-policy";
import { StoreLease } from "../src/lib/store/store-lease";
import { VectorDB } from "../src/lib/store/vector-db";

vi.mock("../src/lib/utils/autostart", () => ({
  autostartDisabledReason: vi.fn(() => null),
}));
vi.mock("../src/lib/utils/safety-latch", () => ({
  safetyStopReason: vi.fn(() => null),
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, statfsSync: vi.fn(original.statfsSync) };
});

const schema = new Schema([
  new Field("id", new Utf8(), false),
  new Field("path", new Utf8(), false),
  new Field("content", new Utf8(), false),
  new Field(
    "vector",
    new FixedSizeList(4, new Field("item", new Float32(), true)),
    false,
  ),
  new Field("colbert", new Binary(), true),
  new Field(
    "defined_symbols",
    new List(new Field("item", new Utf8(), true)),
    true,
  ),
  new Field("start_line", new Int32(), false),
]);

function row(n: number, generation = 0) {
  return {
    id: `id-${n}-${generation}`,
    path: `/repo/src/file-${n % 9}.ts`,
    content: `function alpha${n}() { return "${"x".repeat(n % 40)}" } generation ${generation}`,
    vector: [n, n + 0.5, generation, -n],
    colbert: Buffer.from(Array.from({ length: 64 }, (_, i) => (n + i) % 256)),
    defined_symbols: [`alpha${n}`, `beta${n % 5}`],
    start_line: n * 10,
  };
}

async function snapshot(table: lancedb.Table) {
  const rows = new Map<string, string>();
  for (const r of await table.query().toArray()) {
    rows.set(
      r.id,
      JSON.stringify({
        ...r,
        vector: Array.from(r.vector.toArray()),
        colbert: Buffer.from(r.colbert).toString("hex"),
        defined_symbols: Array.from(r.defined_symbols.toArray()),
      }),
    );
  }
  return rows;
}

describe("gmax compact --once", () => {
  let store: string;

  beforeEach(async () => {
    vi.mocked(fs.statfsSync).mockReturnValue({
      type: 0,
      frsize: 4096,
      bsize: 4096,
      blocks: 100_000_000,
      bfree: 100_000_000,
      bavail: 100_000_000,
      files: 100_000,
      ffree: 100_000,
    });
    store = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-compact-"));
    const db = await lancedb.connect(store);
    const table = await db.createTable("chunks", [row(0)], { schema });
    for (let n = 1; n < 120; n += 2) await table.add([row(n), row(n + 1)]);
    await table.delete("start_line % 30 = 0");
    await table.createIndex("content", {
      config: lancedb.Index.fts({ withPosition: true }),
    });
    await table.createIndex("path", {
      config: lancedb.Index.btree(),
      name: "path_idx",
    });
    // Re-embeds after the index build: deleted rows plus an unindexed tail.
    for (let n = 3; n < 60; n += 6) {
      await table.delete(`id = 'id-${n}-0'`);
      await table.add([row(n, 1)]);
    }
    table.close();
  });

  afterEach(() => {
    vi.mocked(fs.statfsSync).mockReset();
    fs.rmSync(store, { recursive: true, force: true });
    fs.rmSync(`${store}.lease`, { recursive: true, force: true });
  });

  async function open() {
    return (await lancedb.connect(store)).openTable("chunks");
  }

  it("keeps every live row and id, drops deleted rows and merges small fragments", async () => {
    const table = await open();
    const before = await snapshot(table);
    const stats = await table.stats();
    expect(stats.numDeletedRows).toBeGreaterThan(0);
    expect(stats.fragmentStats.numFragments).toBeGreaterThan(60);
    expect((await table.indexStats("content_idx"))!.numUnindexedRows).toBe(10);
    const fields = (await table.schema()).toString();
    table.close();

    const report = await compactStore({ store, once: true, targetBytes: 4096 });

    const after = await open();
    const afterStats = await after.stats();
    expect(report.before.rows).toBe(before.size);
    expect(report.after.rows).toBe(before.size);
    expect(afterStats.numDeletedRows).toBe(0);
    expect(afterStats.fragmentStats.numFragments).toBe(report.fragmentsWritten);
    expect(report.fragmentsWritten).toBeGreaterThan(1);
    expect(report.fragmentsWritten).toBeLessThan(20);
    expect(report.after.unindexedRows).toEqual({ content_idx: 0, path_idx: 0 });
    expect((await after.indexStats("content_idx"))!.numIndexedRows).toBe(
      before.size,
    );
    expect(await snapshot(after)).toEqual(before);
    expect((await after.schema()).toString()).toBe(fields);
    const hits = await after
      .query()
      .fullTextSearch("alpha7")
      .select(["id"])
      .toArray();
    expect(hits.map((h) => h.id)).toContain("id-7-0");
    expect(
      await after.query().where("path = '/repo/src/file-2.ts'").toArray(),
    ).toHaveLength(
      [...before.values()].filter((r) =>
        r.includes('"path":"/repo/src/file-2.ts"'),
      ).length,
    );
    after.close();
  });

  it("restores the source version when a step after the rewrite fails", async () => {
    const table = await open();
    const before = await snapshot(table);
    const fragments = (await table.stats()).fragmentStats.numFragments;
    table.close();
    vi.spyOn(lancedb.Index, "btree").mockImplementationOnce(() => {
      throw new Error("index build failed");
    });
    await expect(
      compactStore({ store, once: true, targetBytes: 4096 }),
    ).rejects.toThrow(
      /index build failed; source version \d+ restored as head/,
    );
    const after = await open();
    expect(await snapshot(after)).toEqual(before);
    expect((await after.stats()).fragmentStats.numFragments).toBe(fragments);
    expect((await after.listIndices()).map((i) => i.name).sort()).toEqual([
      "content_idx",
      "path_idx",
    ]);
    after.close();
  });

  it("refuses a store whose lease a daemon or another writer holds", async () => {
    const reader = await StoreLease.acquireShared({
      storeDir: store,
      nonce: "daemon-reader",
      role: "gmax-daemon",
    });
    try {
      await expect(
        compactStore({ store, once: true, leaseTimeoutMs: 200 }),
      ).rejects.toThrow(/held by a daemon or another writer \(gmax-daemon pid/);
    } finally {
      await reader.release();
    }
    const table = await open();
    expect((await table.stats()).fragmentStats.numFragments).toBeGreaterThan(
      60,
    );
    table.close();
  });

  it("refuses without the table's size plus the disk floor free", async () => {
    vi.mocked(fs.statfsSync).mockReturnValue({
      type: 0,
      frsize: 4096,
      bsize: 4096,
      blocks: 100,
      bfree: 1,
      bavail: 1,
      files: 100,
      ffree: 100,
    });
    const table = await open();
    const version = await table.version();
    await expect(compactStore({ store, once: true })).rejects.toThrow(
      /needs \d+ bytes free/,
    );
    expect(await table.version()).toBe(version);
    table.close();
  });

  it("refuses without --once", async () => {
    await expect(compactStore({ store })).rejects.toThrow(/--once/);
  });

  it("leaves the automatic full-table paths contained", async () => {
    await compactStore({ store, once: true, targetBytes: 4096 });
    expect(fullTableMaintenanceDisabled()).toBe(true);
    const table = await open();
    const version = await table.version();
    const fragments = (await table.stats()).fragmentStats.numFragments;
    const db = new VectorDB(store, 4);
    try {
      expect(await db.optimize()).toMatchObject({
        status: "skipped",
        attempts: 0,
      });
      expect(await db.optimize(5, 60_000, true)).toMatchObject({
        status: "skipped",
      });
    } finally {
      await db.close();
    }
    expect(await table.version()).toBe(version);
    expect((await table.stats()).fragmentStats.numFragments).toBe(fragments);
    table.close();
  });
});
