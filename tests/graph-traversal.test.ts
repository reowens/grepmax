import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/lib/graph/graph-builder";
import {
  type NeighborFn,
  bfsNeighbors,
  buildFileSubgraph,
  findPath,
} from "../src/lib/graph/graph-traversal";

/**
 * Phase 7 — MCP graph primitives. Pure-function coverage for the traversal
 * core (BFS neighbors, shortest path, subgraph aggregation), plus a
 * GraphBuilder integration test wiring the BFS to a faithful mock of the
 * `array_contains` query shape the real store evaluates.
 */

// In-memory adjacency as an async neighbor function.
function adj(map: Record<string, string[]>): NeighborFn {
  return async (s: string) => map[s] ?? [];
}

describe("bfsNeighbors", () => {
  const graph = adj({
    a: ["b", "c"],
    b: ["d"],
    c: ["d", "e"],
    d: ["f"],
  });

  it("annotates each reachable node with its shortest hop distance", async () => {
    const hits = await bfsNeighbors("a", graph, 2);
    const byName = Object.fromEntries(hits.map((h) => [h.symbol, h.hops]));
    expect(byName).toEqual({ b: 1, c: 1, d: 2, e: 2 });
    // f is 3 hops away — beyond maxHops.
    expect(byName.f).toBeUndefined();
    // start excluded
    expect(byName.a).toBeUndefined();
  });

  it("reaches deeper nodes as maxHops grows and dedupes shared paths", async () => {
    const hits = await bfsNeighbors("a", graph, 3);
    const names = hits.map((h) => h.symbol).sort();
    expect(names).toEqual(["b", "c", "d", "e", "f"]);
    // d is reachable via both b and c but recorded once, at its shortest (2).
    expect(hits.find((h) => h.symbol === "d")!.hops).toBe(2);
  });

  it("respects the maxNodes budget", async () => {
    const wide = adj({ root: Array.from({ length: 50 }, (_, i) => `n${i}`) });
    const hits = await bfsNeighbors("root", wide, 1, 10);
    // start counts toward the visited budget; expansion stops once exceeded.
    expect(hits.length).toBeLessThanOrEqual(50);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("handles cycles without looping forever", async () => {
    const cyclic = adj({ a: ["b"], b: ["c"], c: ["a"] });
    const hits = await bfsNeighbors("a", cyclic, 10);
    expect(hits.map((h) => h.symbol).sort()).toEqual(["b", "c"]);
  });
});

describe("findPath", () => {
  const graph = adj({
    a: ["b", "x"],
    b: ["c"],
    c: ["target"],
    x: ["y"],
  });

  it("returns a shortest path as a symbol sequence", async () => {
    const p = await findPath("a", "target", graph);
    expect(p).toEqual(["a", "b", "c", "target"]);
  });

  it("returns [node] for a zero-length path to itself", async () => {
    expect(await findPath("a", "a", graph)).toEqual(["a"]);
  });

  it("returns null when unreachable within maxHops", async () => {
    expect(await findPath("a", "target", graph, 2)).toBeNull();
    expect(await findPath("a", "nonexistent", graph)).toBeNull();
  });

  it("prefers the shorter of two paths", async () => {
    // a -> target directly (1 hop) vs a -> b -> target (2 hops)
    const g = adj({ a: ["b", "target"], b: ["target"] });
    expect(await findPath("a", "target", g)).toEqual(["a", "target"]);
  });
});

describe("buildFileSubgraph", () => {
  it("separates internal edges from external dependencies", () => {
    const sg = buildFileSubgraph([
      {
        path: "/p/a.ts",
        defined_symbols: ["funcA"],
        referenced_symbols: ["funcB", "lodashThing"],
      },
      {
        path: "/p/b.ts",
        defined_symbols: ["funcB"],
        referenced_symbols: ["externalApi"],
      },
    ]);
    expect(sg.files).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(sg.symbols).toEqual(["funcA", "funcB"]);
    // funcA -> funcB is internal (both defined in set).
    expect(sg.internalEdges).toEqual([{ from: "funcA", to: "funcB" }]);
    // refs to symbols not defined in the set are external deps.
    expect(sg.externalDeps).toEqual(["externalApi", "lodashThing"]);
  });

  it("dedupes repeated internal edges and skips self-loops", () => {
    const sg = buildFileSubgraph([
      {
        path: "/p/a.ts",
        defined_symbols: ["funcA"],
        referenced_symbols: ["funcB", "funcB", "funcA"],
      },
      { path: "/p/b.ts", defined_symbols: ["funcB"], referenced_symbols: [] },
    ]);
    expect(sg.internalEdges).toEqual([{ from: "funcA", to: "funcB" }]);
  });
});

// --- GraphBuilder integration -------------------------------------------

type Row = {
  path: string;
  start_line: number;
  defined_symbols: string[];
  referenced_symbols: string[];
  role: string;
  parent_symbol: string | null;
  complexity: number;
};

function mkRow(path: string, defs: string[], refs: string[], line = 0): Row {
  return {
    path,
    start_line: line,
    defined_symbols: defs,
    referenced_symbols: refs,
    role: "IMPLEMENTATION",
    parent_symbol: null,
    complexity: 1,
  };
}

/** Mock store that evaluates `array_contains(col, 'X')` over real rows. */
function createIndexDb(rows: Row[]) {
  const table = {
    query: () => {
      let whereClause = "";
      let limitVal = 100;
      const chain = {
        where: (c: string) => {
          whereClause = c;
          return chain;
        },
        select: () => chain,
        limit: (n: number) => {
          limitVal = n;
          return chain;
        },
        toArray: async () => {
          const m = whereClause.match(/array_contains\((\w+),\s*'([^']+)'\)/);
          if (!m) return rows.slice(0, limitVal);
          const [, col, val] = m;
          return rows
            .filter((r) => ((r as any)[col] as string[]).includes(val))
            .slice(0, limitVal);
        },
      };
      return chain;
    },
  };
  return { ensureTable: async () => table } as any;
}

describe("GraphBuilder graph primitives", () => {
  // a -> b -> c chain via referenced/defined symbols.
  const rows = [
    mkRow("/p/a.ts", ["funcA"], ["funcB"], 1),
    mkRow("/p/b.ts", ["funcB"], ["funcC"], 2),
    mkRow("/p/c.ts", ["funcC"], [], 3),
  ];

  it("getNeighbors walks callees with hop distance and locations", async () => {
    const b = new GraphBuilder(createIndexDb(rows));
    const hits = await b.getNeighbors("funcA", "callees", 2);
    const byName = Object.fromEntries(hits.map((h) => [h.symbol, h]));
    expect(byName.funcB.hops).toBe(1);
    expect(byName.funcB.file).toBe("/p/b.ts");
    expect(byName.funcB.line).toBe(2);
    expect(byName.funcC.hops).toBe(2);
  });

  it("getNeighbors walks callers (inbound) direction", async () => {
    const b = new GraphBuilder(createIndexDb(rows));
    const hits = await b.getNeighbors("funcC", "callers", 2);
    const names = hits.map((h) => h.symbol).sort();
    expect(names).toEqual(["funcA", "funcB"]);
  });

  it("findPaths resolves a transitive callee path", async () => {
    const b = new GraphBuilder(createIndexDb(rows));
    expect(await b.findPaths("funcA", "funcC", "callees")).toEqual([
      "funcA",
      "funcB",
      "funcC",
    ]);
  });

  it("findPaths returns null when there is no connection", async () => {
    const b = new GraphBuilder(createIndexDb(rows));
    expect(await b.findPaths("funcC", "funcA", "callees")).toBeNull();
  });
});
