import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _cachePathForTests,
  _clearMemoryCacheForTests,
  buildGraphFromDb,
  computePageRank,
  loadOrComputePageRank,
  pageRankBoostForSymbols,
} from "../src/lib/search/pagerank";

function mockDbWithRows(
  rows: Array<{ defined_symbols: string[]; referenced_symbols: string[] }>,
) {
  const ensureTable = vi.fn(async () => ({
    query: () => ({
      select: () => ({
        where: () => ({
          toArray: async () => rows,
        }),
      }),
    }),
  }));
  return { ensureTable } as unknown as Parameters<typeof buildGraphFromDb>[0];
}

describe("computePageRank", () => {
  it("returns empty map for empty graph", () => {
    const result = computePageRank({ nodes: [], edges: new Map() });
    expect(result.size).toBe(0);
  });

  it("4-node ring converges to uniform distribution", () => {
    // A → B → C → D → A
    const edges = new Map<string, Set<string>>([
      ["A", new Set(["B"])],
      ["B", new Set(["C"])],
      ["C", new Set(["D"])],
      ["D", new Set(["A"])],
    ]);
    const result = computePageRank(
      { nodes: ["A", "B", "C", "D"], edges },
      0.85,
      200,
      1e-9,
    );
    for (const sym of ["A", "B", "C", "D"]) {
      expect(result.get(sym)!).toBeCloseTo(0.25, 6);
    }
  });

  it("asymmetric 4-node graph ranks central node highest", () => {
    // A→B, A→C, B→C, C→A, D→C  (C is the most-pointed-to hub)
    const edges = new Map<string, Set<string>>([
      ["A", new Set(["B", "C"])],
      ["B", new Set(["C"])],
      ["C", new Set(["A"])],
      ["D", new Set(["C"])],
    ]);
    const result = computePageRank(
      { nodes: ["A", "B", "C", "D"], edges },
      0.85,
      200,
      1e-9,
    );
    const a = result.get("A")!;
    const b = result.get("B")!;
    const c = result.get("C")!;
    const d = result.get("D")!;

    // Ranking: C > A > B > D (D has no in-edges → only teleport mass)
    expect(c).toBeGreaterThan(a);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(d);

    // D has no in-edges and at least one out-edge → score == (1-d)/N
    expect(d).toBeCloseTo(0.15 / 4, 6);

    // Sum should be ~1 (stochastic conservation, no dangling)
    const total = a + b + c + d;
    expect(total).toBeCloseTo(1.0, 4);
  });

  it("handles dangling nodes (no out-edges) without losing mass", () => {
    // A→B, B (dangling)
    const edges = new Map<string, Set<string>>([["A", new Set(["B"])]]);
    const result = computePageRank(
      { nodes: ["A", "B"], edges },
      0.85,
      200,
      1e-9,
    );
    const total = (result.get("A") ?? 0) + (result.get("B") ?? 0);
    expect(total).toBeCloseTo(1.0, 4);
  });

  it("ignores edges pointing to nodes outside the graph", () => {
    // A→external; PR should still be defined for A and equal to 1/N (no in-edges, just teleport+dangling)
    const edges = new Map<string, Set<string>>([
      ["A", new Set(["external_node_not_in_graph"])],
    ]);
    const result = computePageRank({ nodes: ["A"], edges }, 0.85, 50, 1e-9);
    expect(result.get("A")!).toBeCloseTo(1.0, 4);
  });
});

describe("buildGraphFromDb", () => {
  it("builds nodes from defined_symbols and edges from referenced_symbols", async () => {
    const db = mockDbWithRows([
      { defined_symbols: ["foo"], referenced_symbols: ["bar", "baz"] },
      { defined_symbols: ["bar"], referenced_symbols: ["baz"] },
      { defined_symbols: ["baz"], referenced_symbols: [] },
    ]);
    const graph = await buildGraphFromDb(db, "/proj/");
    expect(new Set(graph.nodes)).toEqual(new Set(["foo", "bar", "baz"]));
    expect(graph.edges.get("foo")).toEqual(new Set(["bar", "baz"]));
    expect(graph.edges.get("bar")).toEqual(new Set(["baz"]));
    expect(graph.edges.get("baz")).toBeUndefined();
  });

  it("merges multiple chunks defining the same symbol", async () => {
    const db = mockDbWithRows([
      { defined_symbols: ["foo"], referenced_symbols: ["bar"] },
      { defined_symbols: ["foo"], referenced_symbols: ["baz"] },
    ]);
    const graph = await buildGraphFromDb(db, "/proj/");
    expect(graph.edges.get("foo")).toEqual(new Set(["bar", "baz"]));
  });
});

describe("pageRankBoostForSymbols", () => {
  const scores = new Map<string, number>([
    ["foo", 0.5],
    ["bar", 0.2],
    ["baz", 0.1],
  ]);
  const max = 0.5;

  it("returns 0 for empty/missing symbols", () => {
    expect(pageRankBoostForSymbols(undefined, scores, max)).toBe(0);
    expect(pageRankBoostForSymbols([], scores, max)).toBe(0);
    expect(pageRankBoostForSymbols(["unknown"], scores, max)).toBe(0);
  });

  it("returns max-normalized score across symbols", () => {
    expect(pageRankBoostForSymbols(["bar"], scores, max)).toBeCloseTo(0.4, 6);
    expect(pageRankBoostForSymbols(["foo", "bar"], scores, max)).toBeCloseTo(
      1.0,
      6,
    );
  });

  it("returns 0 when max is 0", () => {
    expect(pageRankBoostForSymbols(["foo"], scores, 0)).toBe(0);
  });
});

describe("loadOrComputePageRank cache", () => {
  const TEST_PREFIX = `/__pagerank_test_${process.pid}_${Date.now()}/`;

  afterEach(() => {
    _clearMemoryCacheForTests();
    const file = _cachePathForTests(TEST_PREFIX);
    try {
      fs.unlinkSync(file);
    } catch {}
  });

  it("computes once, then serves from memory cache", async () => {
    const db = mockDbWithRows([
      { defined_symbols: ["a"], referenced_symbols: ["b"] },
      { defined_symbols: ["b"], referenced_symbols: ["a"] },
    ]);
    const { scores: s1, max: m1 } = await loadOrComputePageRank(
      db,
      TEST_PREFIX,
    );
    expect(s1.size).toBe(2);
    expect(m1).toBeGreaterThan(0);
    const ensureTableMock = (
      db as unknown as { ensureTable: ReturnType<typeof vi.fn> }
    ).ensureTable;
    expect(ensureTableMock).toHaveBeenCalledTimes(1);

    await loadOrComputePageRank(db, TEST_PREFIX);
    expect(ensureTableMock).toHaveBeenCalledTimes(1); // memory hit
  });

  it("falls back to disk cache when memory is cleared", async () => {
    const db = mockDbWithRows([
      { defined_symbols: ["a"], referenced_symbols: ["b"] },
      { defined_symbols: ["b"], referenced_symbols: [] },
    ]);
    await loadOrComputePageRank(db, TEST_PREFIX);
    const file = _cachePathForTests(TEST_PREFIX);
    expect(fs.existsSync(file)).toBe(true);

    _clearMemoryCacheForTests();
    const ensureTableMock = (
      db as unknown as { ensureTable: ReturnType<typeof vi.fn> }
    ).ensureTable;
    ensureTableMock.mockClear();

    const { scores: s2 } = await loadOrComputePageRank(db, TEST_PREFIX);
    expect(s2.size).toBe(2);
    expect(ensureTableMock).not.toHaveBeenCalled(); // disk hit
  });
});
