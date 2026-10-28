import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CONFIG } from "../src/config";
import { Searcher } from "../src/lib/search/searcher";
import { VectorDB } from "../src/lib/store/vector-db";

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const rows = [BigInt(0), BigInt("9007199254740993")].map((rowId, i) => ({
    id: `row-${i}`,
    _rowid: rowId as unknown,
    path: `/fixture/source-${i}.ts`,
    hash: `hash-${i}`,
    content:
      "export function handler() { return 'a sufficiently long fixture body'; }",
    start_line: 0,
    end_line: 4,
    chunk_index: 0,
    chunk_type: "function",
    is_exported: true,
    role: "IMPLEMENTATION",
    summary: `summary-${i}`,
    defined_symbols: [`handler${i}`],
    imports: [`dependency-${i}`],
    colbert: Buffer.alloc(48, i + 1),
    colbert_scale: 1,
    doc_token_ids: [100 + i],
  }));
  const chain = (read: () => unknown[]) => {
    const query = {
      withRowId: vi.fn(() => query),
      select: vi.fn(() => query),
      limit: vi.fn(() => query),
      where: vi.fn(() => query),
      toArray: vi.fn(async () => read()),
    };
    return query;
  };
  const light = (i: number) => ({
    ...rows[i],
    summary: undefined,
    imports: undefined,
    defined_symbols: undefined,
    colbert: undefined,
    doc_token_ids: undefined,
  });
  const vector = chain(() => [light(0)]);
  const fts = chain(() => [light(1)]);
  let pinned = false;
  const table = {
    version: vi.fn(async () => 7),
    checkout: vi.fn(async (version: number) => {
      expect(version).toBe(7);
      pinned = true;
    }),
    close: vi.fn(),
    vectorSearch: vi.fn(() => {
      expect(pinned).toBe(true);
      return vector;
    }),
    search: vi.fn(() => fts),
    query: vi.fn(() => {
      throw new Error("ID scans forbidden");
    }),
    takeRowIds: vi.fn((ids: readonly (bigint | number)[]) => {
      expect(pinned).toBe(true);
      // Return payloads in a different order to verify association by ID.
      return chain(() =>
        rows.filter((row) => ids.includes(row._rowid as bigint)).reverse(),
      );
    }),
  };
  const pool = {
    encodeQuery: vi.fn(async () => ({
      dense: [1],
      colbert: [[1]],
      colbertDim: 48,
    })),
    rerank: vi.fn(async (input: { docs: unknown[] }) =>
      input.docs.map((_, i) => i + 1),
    ),
  };
  const searcher = new Searcher(
    {
      ensureTable: async () => table,
      adoptFTSIndex: async () => {},
    } as unknown as VectorDB,
    pool,
  );
  return { rows, table, vector, fts, pool, searcher };
}

it("takes zero and 64-bit row IDs from vector and FTS results without ID scans", async () => {
  const f = fixture();
  const result = await f.searcher.search("where are requests handled", 10, {
    rerank: true,
    diagnostics: true,
  });
  expect(f.vector.withRowId).toHaveBeenCalledOnce();
  expect(f.fts.withRowId).toHaveBeenCalledOnce();
  expect(f.table.takeRowIds.mock.calls.map(([ids]) => ids)).toEqual([
    [BigInt(0), BigInt("9007199254740993")],
    [BigInt("9007199254740993"), BigInt(0)],
  ]);
  expect(f.pool.rerank.mock.calls[0][0].docs).toMatchObject([
    { colbert: Buffer.alloc(48, 1), token_ids: [100] },
    { colbert: Buffer.alloc(48, 2), token_ids: [101] },
  ]);
  expect(result.data.map((row) => row.summary)).toEqual([
    "summary-1",
    "summary-0",
  ]);
  expect(result.data.map((row) => row.imports)).toEqual([
    ["dependency-1"],
    ["dependency-0"],
  ]);
  expect(() => JSON.stringify(result)).not.toThrow();
  expect(f.table.query).not.toHaveBeenCalled();
  expect(f.table.close).toHaveBeenCalledOnce();
});

it.each(["version", "checkout", "vector", "take", "rerank"])(
  "closes the search snapshot when %s fails",
  async (stage) => {
    const f = fixture();
    const error = new Error(`failed ${stage}`);
    if (stage === "version") f.table.version.mockRejectedValue(error);
    if (stage === "checkout") f.table.checkout.mockRejectedValue(error);
    if (stage === "vector") f.vector.toArray.mockRejectedValue(error);
    if (stage === "take")
      f.table.takeRowIds.mockImplementation(() => {
        throw error;
      });
    if (stage === "rerank") f.pool.rerank.mockRejectedValue(error);
    await expect(
      f.searcher.search("where are requests handled", 10, { rerank: true }),
    ).rejects.toThrow(error);
    expect(f.table.close).toHaveBeenCalledOnce();
    expect(f.table.query).not.toHaveBeenCalled();
  },
);

it.each([undefined, -1, Number.MAX_SAFE_INTEGER + 1, BigInt(-1)])(
  "rejects an invalid candidate row ID (%s) instead of scanning IDs",
  async (rowId) => {
    const f = fixture();
    f.rows[0]._rowid = rowId;
    await expect(
      f.searcher.search("where are requests handled", 10, { rerank: true }),
    ).rejects.toThrow("valid Lance row ID");
    expect(f.table.query).not.toHaveBeenCalled();
    expect(f.table.close).toHaveBeenCalledOnce();
  },
);

it("closes an empty snapshot without fetching payloads", async () => {
  const f = fixture();
  f.vector.toArray.mockResolvedValue([]);
  f.fts.toArray.mockResolvedValue([]);
  expect((await f.searcher.search("where are requests handled")).data).toEqual(
    [],
  );
  expect(f.table.takeRowIds).not.toHaveBeenCalled();
  expect(f.table.close).toHaveBeenCalledOnce();
});

it("closes the snapshot when cancellation arrives during retrieval", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.vector.toArray.mockImplementation(async () => {
    controller.abort();
    return [f.rows[0]];
  });
  await expect(
    f.searcher.search(
      "where are requests handled",
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    ),
  ).rejects.toThrow("Aborted");
  expect(f.table.takeRowIds).not.toHaveBeenCalled();
  expect(f.table.close).toHaveBeenCalledOnce();
});

it("keeps native payload reads on their retrieval version while a writer updates rows", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-search-rowids-"));
  const db = new VectorDB(root, CONFIG.VECTOR_DIM);
  let writer: Awaited<ReturnType<VectorDB["ensureTable"]>> | undefined;
  try {
    const vector = Array(CONFIG.VECTOR_DIM).fill(0);
    vector[0] = 1;
    const seed = (db as any).seedRow();
    await db.insertBatch([
      {
        ...seed,
        id: "native-row",
        path: path.join(root, "source.ts"),
        hash: "native-row",
        content:
          "export function source() { return 'a sufficiently long native fixture body'; }",
        defined_symbols: ["source"],
        vector,
        start_line: 0,
        end_line: 4,
        summary: "before update",
        imports: ["before"],
        colbert: Buffer.alloc(48, 1),
        colbert_scale: 1,
        doc_token_ids: [100],
        is_exported: true,
      },
    ]);
    writer = await db.ensureTable();
    let updated = false;
    const pool = {
      encodeQuery: async () => ({
        dense: vector,
        colbert: [[1]],
        colbertDim: 48,
      }),
      rerank: async (input: { docs: unknown[] }) => {
        if (!updated) {
          await writer!.update({
            where: "id = 'native-row'",
            values: { summary: "after update", imports: ["after"] },
          });
          updated = true;
        }
        return input.docs.map(() => 1);
      },
    };
    const searcher = new Searcher(db, pool);
    const before = await searcher.search("where is the source", 1, {
      rerank: true,
    });
    expect(before.data[0].summary).toBe("before update");
    expect(before.data[0].imports).toEqual(["before"]);
    const after = await searcher.search("where is the source", 1, {
      rerank: true,
    });
    expect(after.data[0].summary).toBe("after update");
    expect(after.data[0].imports).toEqual(["after"]);
    expect(updated).toBe(true);
  } finally {
    writer?.close();
    await db.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}.lease`, { recursive: true, force: true });
  }
}, 15_000);
