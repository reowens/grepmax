import { describe, expect, it, vi } from "vitest";
import { GraphBuilder } from "../src/lib/graph/graph-builder";
import { bfsNeighbors, findPath } from "../src/lib/graph/graph-traversal";
import { GraphWorkBudget } from "../src/lib/graph/work-budget";

describe("hard traversal work bounds", () => {
  it("stops in one wide batch, and never fetches another frontier", async () => {
    const next = vi.fn(async () =>
      Array.from({ length: 10_000 }, (_, i) => `n${i}`),
    );
    const work = new GraphWorkBudget({ visitedNodes: 10 });
    const hits = await bfsNeighbors("root", next, 5, 10, work);
    expect(hits).toHaveLength(9);
    expect(next).toHaveBeenCalledTimes(1);
    expect(work.snapshot()).toMatchObject({
      status: "partial",
      reasons: ["visitedNodes_limit"],
      counts: { visitedNodes: 10, expansions: 1 },
    });
  });

  it("bounds queued work independently of visited nodes", async () => {
    const work = new GraphWorkBudget({ queuedNodes: 2 });
    const hits = await bfsNeighbors(
      "root",
      async () => ["a", "b", "c"],
      3,
      500,
      work,
    );
    expect(hits.map((h) => h.symbol)).toEqual(["a", "b"]);
    expect(work.snapshot()).toMatchObject({
      reasons: ["queuedNodes_limit"],
      counts: { queuedNodes: 2, visitedNodes: 3 },
    });
  });

  it("duplicate edges consume work even when they add no nodes", async () => {
    const work = new GraphWorkBudget({ examinedEdges: 4 });
    const next = vi.fn(async () => [...Array(1000).fill("root"), "target"]);
    expect(await findPath("root", "target", next, 5, 500, work)).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
    expect(work.snapshot()).toMatchObject({
      outcome: "budget_limit",
      reasons: ["examinedEdges_limit"],
      counts: { examinedEdges: 4, visitedNodes: 1 },
    });
  });

  it("separates expansion limits from hop boundaries", async () => {
    const next = vi.fn(async (s: string) => [`${s}x`]);
    const expansion = new GraphWorkBudget({ expansions: 2 });
    await bfsNeighbors("root", next, 5, 500, expansion);
    expect(next).toHaveBeenCalledTimes(2);
    expect(expansion.snapshot().reasons).toEqual(["expansions_limit"]);
    const hop = new GraphWorkBudget();
    await bfsNeighbors("root", next, 1, 500, hop);
    expect(hop.snapshot()).toMatchObject({
      outcome: "hop_limit",
      reasons: ["hop_limit"],
    });
  });

  it("reports exhausted cycles and an exact-cap graph without a false limit", async () => {
    const work = new GraphWorkBudget({ visitedNodes: 2 });
    expect(
      await bfsNeighbors(
        "root",
        async (s) => (s === "root" ? ["a"] : ["root"]),
        10,
        2,
        work,
      ),
    ).toEqual([{ symbol: "a", hops: 1 }]);
    expect(work.snapshot()).toMatchObject({
      status: "complete",
      outcome: "exhausted",
      counts: { visitedNodes: 2, examinedEdges: 2 },
    });
  });

  it("checks the deadline after awaiting the provider, before consuming its batch", async () => {
    let now = 0;
    const work = new GraphWorkBudget({ deadlineMs: 5 }, () => now);
    const next = vi.fn(async () => {
      now = 6;
      return ["a", "target"];
    });
    expect(await findPath("root", "target", next, 5, 500, work)).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
    expect(work.snapshot()).toMatchObject({
      reasons: ["deadline"],
      counts: { examinedEdges: 0 },
    });
  });

  it("retains the path primitive's intended thousand-node ceiling", async () => {
    const next = vi.fn(async () =>
      Array.from({ length: 999 }, (_, i) => `n${i}`),
    );
    expect(await findPath("root", "n998", next, 1)).toEqual(["root", "n998"]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("finds a target within budget and does no later expansion", async () => {
    const work = new GraphWorkBudget();
    const next = vi.fn(async () => ["a", "target", "unused"]);
    expect(await findPath("root", "target", next, 3, 500, work)).toEqual([
      "root",
      "target",
    ]);
    expect(next).toHaveBeenCalledTimes(1);
    expect(work.snapshot()).toMatchObject({
      status: "complete",
      outcome: "target_found",
      counts: { examinedEdges: 2 },
    });
  });
});

function store(rows: any[], queryHook?: () => Promise<any[]>) {
  const queries: Array<{ limit: number; timeout: number }> = [];
  const db = {
    ensureTable: async () => ({
      query: () => {
        let limit = 0;
        let selected: string[] = [];
        const chain = {
          select: (columns: string[]) => {
            selected = columns;
            return chain;
          },
          where: () => chain,
          limit: (n: number) => {
            limit = n;
            return chain;
          },
          toArray: async (options: { timeoutMs: number }) => {
            queries.push({ limit, timeout: options.timeoutMs });
            return queryHook
              ? queryHook()
              : rows
                  .slice(0, limit)
                  .map((row) =>
                    Object.fromEntries(selected.map((key) => [key, row[key]])),
                  );
          },
        };
        return chain;
      },
    }),
  } as any;
  return { db, queries };
}

describe("store traversal budgets", () => {
  const row = {
    path: "/a.ts",
    defined_symbols: ["root"],
    referenced_symbols: ["next"],
    member_referenced_symbols: [],
    type_referenced_symbols: [],
    start_line: 0,
  };
  it("counts rows rejected by language policy and clips native queries to remaining rows", async () => {
    const { db, queries } = store(
      Array.from({ length: 100 }, () => ({ ...row, path: "/foreign.py" })),
    );
    const work = new GraphWorkBudget({ fetchedRows: 3 });
    const b = new GraphBuilder(db);
    expect(await b.getCallers("root", "js_ts", undefined, work)).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0].limit).toBe(3);
    expect(work.snapshot().counts.fetchedRows).toBe(3);
    expect(await b.getCallers("root", undefined, undefined, work)).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(work.snapshot().reasons).toContain("fetchedRows_limit");
  });

  it("bounds very wide per-row symbol arrays without reading the rest", async () => {
    let reads = 0;
    const wide = {
      length: 1_000_000,
      get: () => {
        reads++;
        return "next";
      },
    };
    const { db, queries } = store([{ ...row, referenced_symbols: wide }]);
    const work = new GraphWorkBudget({ symbolItems: 5 });
    await new GraphBuilder(db).getNeighbors("root", "callees", 5, work);
    expect(reads).toBe(5);
    expect(queries).toHaveLength(1);
    expect(work.snapshot()).toMatchObject({
      reasons: ["symbolItems_limit"],
      counts: { symbolItems: 5 },
    });
  });

  it("supplies the remaining native deadline and returns an explicit timeout partial", async () => {
    const { db, queries } = store([], async () => new Promise(() => {}));
    const work = new GraphWorkBudget({ deadlineMs: 15 });
    expect(
      await new GraphBuilder(db).findPaths(
        "root",
        "target",
        "callees",
        5,
        work,
      ),
    ).toBeNull();
    expect(queries).toHaveLength(1);
    expect(queries[0].timeout).toBeGreaterThan(0);
    expect(queries[0].timeout).toBeLessThanOrEqual(15);
    expect(work.snapshot().reasons).toContain("deadline");
  });

  it("does not turn store failures into an exhausted or partial-success answer", async () => {
    const { db } = store([], async () => {
      throw new Error("corrupt manifest");
    });
    await expect(
      new GraphBuilder(db).findPaths("root", "target", "callees"),
    ).rejects.toThrow("corrupt manifest");
  });
});
