import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureAnnVectorQuery,
  isAnnEnabled,
} from "../src/lib/store/ann-config";
import { VectorDB } from "../src/lib/store/vector-db";

function fakeTable(
  options: {
    rows?: number;
    indices?: Array<{ name: string; columns: string[]; indexType: string }>;
    stats?: {
      numIndexedRows: number;
      numUnindexedRows: number;
      indexType: string;
      distanceType?: string;
    };
  } = {},
) {
  return {
    countRows: vi.fn(async () => options.rows ?? 100_000),
    listIndices: vi.fn(async () => options.indices ?? []),
    indexStats: vi.fn(async () => options.stats),
    createIndex: vi.fn(async () => {}),
    dropIndex: vi.fn(async () => {}),
  };
}

describe("VectorDB ANN index creation", () => {
  let root: string;
  let db: VectorDB;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-ann-index-"));
    db = new VectorDB(path.join(root, "lancedb"), 384);
    process.env.GMAX_ANN = "1";
    process.env.GMAX_ANN_MIN_ROWS = "50000";
    vi.spyOn(db, "checkDiskPressure").mockReturnValue("ok");
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    await db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function inject(table: ReturnType<typeof fakeTable>): void {
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(table);
  }

  it("builds only the exact path index when ANN is disabled", async () => {
    process.env.GMAX_ANN = "0";
    const table = fakeTable();
    inject(table);

    expect(await db.createVectorIndex()).toBe(true);
    expect(table.createIndex).toHaveBeenCalledOnce();
    expect(table.createIndex).toHaveBeenCalledWith(
      "path",
      expect.objectContaining({ name: "path_idx", replace: true }),
    );
  });

  it("skips tables below the configured row threshold", async () => {
    const table = fakeTable({ rows: 49_999 });
    inject(table);

    expect(await db.createVectorIndex()).toBe(false);
    expect(table.createIndex).not.toHaveBeenCalled();
  });

  it("builds IVF_FLAT and path btree indexes", async () => {
    const table = fakeTable();
    inject(table);

    expect(await db.createVectorIndex()).toBe(true);
    expect(table.createIndex).toHaveBeenCalledTimes(2);
    expect(table.createIndex).toHaveBeenNthCalledWith(
      1,
      "vector",
      expect.objectContaining({ name: "vector_idx", replace: true }),
    );
    expect(table.createIndex).toHaveBeenNthCalledWith(
      2,
      "path",
      expect.objectContaining({ name: "path_idx", replace: true }),
    );
  });

  it("is idempotent for a fresh l2 index and path index", async () => {
    const table = fakeTable({
      indices: [
        { name: "vector_idx", columns: ["vector"], indexType: "IVF_FLAT" },
        { name: "path_idx", columns: ["path"], indexType: "BTREE" },
      ],
      stats: {
        numIndexedRows: 100_000,
        numUnindexedRows: 10_000,
        indexType: "IVF_FLAT",
        distanceType: "l2",
      },
    });
    inject(table);

    expect(await db.createVectorIndex()).toBe(false);
    expect(table.createIndex).not.toHaveBeenCalled();
  });

  it.each([
    ["metric drift", "cosine", 0],
    ["stale tail", "l2", 25_000],
  ])("rebuilds on %s", async (_label, distanceType, numUnindexedRows) => {
    const table = fakeTable({
      indices: [
        { name: "vector_idx", columns: ["vector"], indexType: "IVF_FLAT" },
        { name: "path_idx", columns: ["path"], indexType: "BTREE" },
      ],
      stats: {
        numIndexedRows: 100_000,
        numUnindexedRows,
        indexType: "IVF_FLAT",
        distanceType,
      },
    });
    inject(table);

    expect(await db.createVectorIndex()).toBe(true);
    expect(table.createIndex).toHaveBeenCalledOnce();
    expect(table.createIndex).toHaveBeenCalledWith(
      "vector",
      expect.objectContaining({ replace: true }),
    );
  });

  it("retries commit conflicts", async () => {
    vi.useFakeTimers();
    const table = fakeTable();
    table.createIndex
      .mockRejectedValueOnce(new Error("Retryable commit conflict"))
      .mockResolvedValue(undefined);
    inject(table);

    const building = db.createVectorIndex(false, 2);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(building).resolves.toBe(true);
    expect(table.createIndex).toHaveBeenCalledTimes(3);
  });
});

describe("ANN vector query configuration", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function fakeQuery() {
    const query: any = {
      column: vi.fn(() => query),
      minimumNprobes: vi.fn(() => query),
      maximumNprobes: vi.fn(() => query),
      bypassVectorIndex: vi.fn(() => query),
    };
    return query;
  }

  it("selects the vector column and bypasses ANN by default", () => {
    delete process.env.GMAX_ANN;
    const query = fakeQuery();

    configureAnnVectorQuery(query);

    expect(isAnnEnabled()).toBe(false);
    expect(query.column).toHaveBeenCalledWith("vector");
    expect(query.bypassVectorIndex).toHaveBeenCalledOnce();
  });

  it("applies configured adaptive probe bounds when enabled", () => {
    process.env.GMAX_ANN = "1";
    process.env.GMAX_ANN_NPROBES = "32";
    process.env.GMAX_ANN_MAX_NPROBES = "128";
    const query = fakeQuery();

    configureAnnVectorQuery(query);

    expect(query.column).toHaveBeenCalledWith("vector");
    expect(query.minimumNprobes).toHaveBeenCalledWith(32);
    expect(query.maximumNprobes).toHaveBeenCalledWith(128);
    expect(query.bypassVectorIndex).not.toHaveBeenCalled();
  });
});
