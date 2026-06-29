import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/lib/graph/graph-builder";

function createMockDb(data: Record<string, any[]>) {
  const mockTable = {
    query: () => {
      let whereClause = "";
      let _selectedFields: string[] | null = null;
      let limitVal = 100;

      const chain = {
        where: (clause: string) => {
          whereClause = clause;
          return chain;
        },
        select: (fields: string[]) => {
          _selectedFields = fields;
          return chain;
        },
        limit: (n: number) => {
          limitVal = n;
          return chain;
        },
        toArray: async () => {
          for (const [pattern, rows] of Object.entries(data)) {
            if (whereClause.includes(pattern)) {
              return rows.slice(0, limitVal);
            }
          }
          return [];
        },
      };
      return chain;
    },
  };

  return { ensureTable: async () => mockTable } as any;
}

function makeRow(
  symbol: string,
  file: string,
  line: number,
  refs: string[] = [],
  memberRefs: string[] = [],
) {
  return {
    path: file,
    start_line: line,
    defined_symbols: [symbol],
    referenced_symbols: refs,
    // member names are additive — they also appear in referenced_symbols.
    member_referenced_symbols: memberRefs,
    type_referenced_symbols: [],
    role: "ORCHESTRATION",
    parent_symbol: null,
    complexity: 5,
    content: `import { ${symbol} } from "./${file}"`,
  };
}

describe("GraphBuilder", () => {
  it("buildGraph returns center with callers and callees", async () => {
    const db = createMockDb({
      "defined_symbols, 'handleAuth'": [
        makeRow("handleAuth", "/src/auth.ts", 10, ["validate", "respond"]),
      ],
      "referenced_symbols, 'handleAuth'": [
        makeRow("router", "/src/router.ts", 5, ["handleAuth"]),
      ],
      "defined_symbols, 'validate'": [makeRow("validate", "/src/jwt.ts", 20)],
      "defined_symbols, 'respond'": [
        makeRow("respond", "/src/response.ts", 30),
      ],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraph("handleAuth");

    expect(graph.center).not.toBeNull();
    expect(graph.center!.symbol).toBe("handleAuth");
    expect(graph.center!.file).toBe("/src/auth.ts");
    expect(graph.callers.length).toBe(1);
    expect(graph.callers[0].symbol).toBe("router");
    expect(graph.callees.length).toBe(2);
  });

  it("buildGraph callee prefers a definition in the center's own file", async () => {
    const db = createMockDb({
      "defined_symbols, 'handleAuth'": [
        makeRow("handleAuth", "/src/auth.ts", 10, ["validate"]),
      ],
      "referenced_symbols, 'handleAuth'": [],
      // `validate` is defined twice: an unrelated module first (what the old
      // arbitrary .limit(1) would have picked) and the center's own file second.
      "defined_symbols, 'validate'": [
        makeRow("validate", "/src/other.ts", 99),
        makeRow("validate", "/src/auth.ts", 42),
      ],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraph("handleAuth");

    expect(graph.callees.length).toBe(1);
    expect(graph.callees[0].symbol).toBe("validate");
    // prefer-self: resolves to the center's file, not the first (other.ts) row.
    expect(graph.callees[0].file).toBe("/src/auth.ts");
    expect(graph.callees[0].line).toBe(42);
  });

  it("buildGraph callee prefers same language when no self-file candidate exists", async () => {
    const db = createMockDb({
      "defined_symbols, 'handle'": [
        makeRow("handle", "/src/view.py", 10, ["validate"]),
      ],
      "referenced_symbols, 'handle'": [],
      // TS appears first, but the Python center should resolve the Python callee.
      "defined_symbols, 'validate'": [
        makeRow("validate", "/src/validate.ts", 1),
        makeRow("validate", "/src/validate.py", 2),
      ],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraph("handle");

    expect(graph.callees.length).toBe(1);
    expect(graph.callees[0].file).toBe("/src/validate.py");
    expect(graph.callees[0].line).toBe(2);
  });

  it("buildGraph callee falls back to first row when none is self-file", async () => {
    const db = createMockDb({
      "defined_symbols, 'handleAuth'": [
        makeRow("handleAuth", "/src/auth.py", 10, ["validate"]),
      ],
      "referenced_symbols, 'handleAuth'": [],
      // No definition is in the center's file or language family → first-row fallback.
      "defined_symbols, 'validate'": [
        makeRow("validate", "/src/a.ts", 1),
        makeRow("validate", "/src/b.rb", 2),
      ],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraph("handleAuth");

    expect(graph.callees.length).toBe(1);
    expect(graph.callees[0].file).toBe("/src/a.ts");
    expect(graph.callees[0].line).toBe(1);
  });

  it("getCallers tags free vs member edges and sorts free (EXTRACTED) first", async () => {
    const db = createMockDb({
      "defined_symbols, 'save'": [makeRow("save", "/src/db.ts", 10)],
      // Scan order: member caller first, free caller second. The confidence sort
      // must surface the free call ahead of the member call.
      "referenced_symbols, 'save'": [
        makeRow("memberCaller", "/src/a.ts", 5, ["save"], ["save"]),
        makeRow("freeCaller", "/src/b.ts", 7, ["save"], []),
      ],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraph("save");

    expect(graph.callers.length).toBe(2);
    expect(graph.callers[0].symbol).toBe("freeCaller");
    expect(graph.callers[0].edgeKind).toBe("free");
    expect(graph.callers[0].confidence).toBe("EXTRACTED");
    expect(graph.callers[1].symbol).toBe("memberCaller");
    expect(graph.callers[1].edgeKind).toBe("member");
    expect(graph.callers[1].confidence).toBe("INFERRED");
  });

  it("getCallers suppresses member callers of a builtin-named symbol", async () => {
    // Tracing `get` (a builtin name): `x.get()` member callers are stdlib noise
    // and dropped; a free `get()` caller is kept.
    const db = createMockDb({
      "defined_symbols, 'get'": [makeRow("get", "/src/store.ts", 3)],
      "referenced_symbols, 'get'": [
        makeRow("memberNoise", "/src/a.ts", 5, ["get"], ["get"]),
        makeRow("realCaller", "/src/b.ts", 7, ["get"], []),
      ],
    });
    const builder = new GraphBuilder(db);
    // null anchorFamily → isolate the builtin-member suppression from the
    // cross-language family guard.
    const callers = await builder.getCallers("get", null);

    expect(callers.map((c) => c.symbol)).toEqual(["realCaller"]);
  });

  it("buildGraph returns null center when symbol not found", async () => {
    const db = createMockDb({});
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraph("nonexistent");

    expect(graph.center).toBeNull();
    expect(graph.callers).toEqual([]);
    expect(graph.callees).toEqual([]);
  });

  it("buildGraphMultiHop with depth 1 returns flat callerTree", async () => {
    const db = createMockDb({
      "defined_symbols, 'fn'": [makeRow("fn", "/a.ts", 1, [])],
      "referenced_symbols, 'fn'": [makeRow("caller", "/b.ts", 5, ["fn"])],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraphMultiHop("fn", 1);

    expect(graph.callerTree.length).toBe(1);
    expect(graph.callerTree[0].node.symbol).toBe("caller");
    expect(graph.callerTree[0].callers).toEqual([]);
  });

  it("buildGraphMultiHop with depth 2 expands callers", async () => {
    const db = createMockDb({
      "defined_symbols, 'fn'": [makeRow("fn", "/a.ts", 1)],
      "referenced_symbols, 'fn'": [makeRow("mid", "/b.ts", 5, ["fn"])],
      "referenced_symbols, 'mid'": [makeRow("top", "/c.ts", 10, ["mid"])],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraphMultiHop("fn", 2);

    expect(graph.callerTree.length).toBe(1);
    expect(graph.callerTree[0].node.symbol).toBe("mid");
    expect(graph.callerTree[0].callers.length).toBe(1);
    expect(graph.callerTree[0].callers[0].node.symbol).toBe("top");
  });

  it("buildGraphMultiHop detects cycles", async () => {
    const db = createMockDb({
      "defined_symbols, 'a'": [makeRow("a", "/a.ts", 1, ["b"])],
      "referenced_symbols, 'a'": [makeRow("b", "/b.ts", 5, ["a"])],
      "referenced_symbols, 'b'": [makeRow("a", "/a.ts", 1, ["b"])],
      "defined_symbols, 'b'": [makeRow("b", "/b.ts", 5)],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraphMultiHop("a", 3);

    // Should not infinite loop — cycle detection stops expansion
    expect(graph.callerTree.length).toBe(1);
    expect(graph.callerTree[0].node.symbol).toBe("b");
    // b's caller is a, but a is the center (visited) — should be empty
    expect(graph.callerTree[0].callers.length).toBe(1);
    // The recursive caller of b is a, which is already visited
    expect(graph.callerTree[0].callers[0].callers).toEqual([]);
  });

  it("getImporters finds files with import statements", async () => {
    const db = createMockDb({
      import: [
        {
          path: "/src/commands/mcp.ts",
          content: 'import { VectorDB } from "../store"',
        },
        { path: "/src/index.ts", content: 'import { VectorDB } from "./db"' },
        { path: "/src/store.ts", content: "export class VectorDB {}" },
      ],
    });
    const builder = new GraphBuilder(db);
    const importers = await builder.getImporters("VectorDB");

    expect(importers.length).toBe(3);
    expect(importers).toContain("/src/commands/mcp.ts");
  });

  it("scopeWhere appends NOT LIKE for each excludePrefix", async () => {
    let capturedWhere = "";
    const captureDb = {
      ensureTable: async () => ({
        query: () => {
          const chain = {
            where: (clause: string) => {
              capturedWhere = clause;
              return chain;
            },
            select: () => chain,
            limit: () => chain,
            toArray: async () => [],
          };
          return chain;
        },
      }),
    } as any;

    const builder = new GraphBuilder(captureDb, "/p/app", [
      "/p/app/tests",
      "/p/app/docs/",
    ]);
    await builder.getCallers("foo");

    expect(capturedWhere).toContain("starts_with(path, '/p/app/')");
    expect(capturedWhere).toContain("NOT starts_with(path, '/p/app/tests/')");
    expect(capturedWhere).toContain("NOT starts_with(path, '/p/app/docs/')");
  });

  it("suppresses cross-language phantom callers", async () => {
    // `render` is defined in Python; a TSX chunk references an unrelated
    // `render`. The TSX caller must NOT cross-connect to the Python definition,
    // while a same-language (Python) caller is kept.
    const db = createMockDb({
      "defined_symbols, 'render'": [makeRow("render", "/app/view.py", 10)],
      "referenced_symbols, 'render'": [
        makeRow("Component", "/app/widget.tsx", 5, ["render"]),
        makeRow("main", "/app/cli.py", 8, ["render"]),
      ],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraph("render");

    expect(graph.center!.file).toBe("/app/view.py");
    expect(graph.callers.map((c) => c.file)).toEqual(["/app/cli.py"]);
  });

  it("getCallers applies an explicit language-family anchor", async () => {
    const db = createMockDb({
      "referenced_symbols, 'render'": [
        makeRow("Component", "/app/widget.tsx", 5, ["render"]),
        makeRow("main", "/app/cli.py", 8, ["render"]),
      ],
    });
    const builder = new GraphBuilder(db);
    const callers = await builder.getCallers("render", "python");

    expect(callers.map((c) => c.file)).toEqual(["/app/cli.py"]);
  });

  it("keeps callers across the JS/TS family (ts ↔ tsx)", async () => {
    // tsx and ts share a call namespace, so a .ts definition keeps its .tsx
    // caller — the guard must not over-filter within a family.
    const db = createMockDb({
      "defined_symbols, 'useStore'": [makeRow("useStore", "/app/store.ts", 3)],
      "referenced_symbols, 'useStore'": [
        makeRow("Panel", "/app/Panel.tsx", 12, ["useStore"]),
      ],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraph("useStore");

    expect(graph.callers.map((c) => c.file)).toEqual(["/app/Panel.tsx"]);
  });

  it("does not filter callers when the definition language is unknown", async () => {
    // Symbol not locally defined (no center) → anchor is null → keep every
    // caller regardless of language (no regression for external symbols).
    const db = createMockDb({
      "referenced_symbols, 'ext'": [
        makeRow("a", "/app/a.tsx", 1, ["ext"]),
        makeRow("b", "/app/b.py", 2, ["ext"]),
      ],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraph("ext");

    expect(graph.center).toBeNull();
    expect(graph.callers.length).toBe(2);
  });

  it("unresolved callees have empty file", async () => {
    const db = createMockDb({
      "defined_symbols, 'fn'": [makeRow("fn", "/a.ts", 1, ["unknownFn"])],
      "referenced_symbols, 'fn'": [],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraph("fn");

    expect(graph.callees.length).toBe(1);
    expect(graph.callees[0].symbol).toBe("unknownFn");
    expect(graph.callees[0].file).toBe("");
  });

  it("buildGraph drops unresolved builtin callees but keeps resolved ones", async () => {
    // `forEach` is a builtin with no project definition → phantom edge, suppress.
    // `realFn` resolves → kept. `get` is a builtin NAME but the project defines
    // it (cache/store method) → resolves → kept (resolution-aware, not blanket).
    const db = createMockDb({
      "defined_symbols, 'fn'": [
        makeRow("fn", "/a.ts", 1, ["forEach", "realFn", "get"]),
      ],
      "referenced_symbols, 'fn'": [],
      "defined_symbols, 'realFn'": [makeRow("realFn", "/b.ts", 5)],
      "defined_symbols, 'get'": [makeRow("get", "/cache.ts", 9)],
    });
    const builder = new GraphBuilder(db);
    const graph = await builder.buildGraph("fn");

    const names = graph.callees.map((c) => c.symbol);
    expect(names).toContain("realFn");
    expect(names).toContain("get"); // shadows a builtin but is indexed → kept
    expect(names).not.toContain("forEach"); // unresolved builtin → suppressed
  });

  it("getNeighbors drops unresolved builtin callee neighbors", async () => {
    // `map` is an unresolved builtin reached via a callee edge → suppress;
    // `helper` resolves → kept.
    const db = createMockDb({
      "defined_symbols, 'fn'": [makeRow("fn", "/a.ts", 1, ["map", "helper"])],
      "defined_symbols, 'helper'": [makeRow("helper", "/b.ts", 5)],
    });
    const builder = new GraphBuilder(db);
    const hits = await builder.getNeighbors("fn", "callees", 1);

    const names = hits.map((h) => h.symbol);
    expect(names).toContain("helper");
    expect(names).not.toContain("map");
  });
});
