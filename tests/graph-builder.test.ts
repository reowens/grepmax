import { beforeEach, describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/lib/graph/graph-builder";

function createMockDb(data: Record<string, any[]>) {
  const mockTable = {
    query: () => {
      let whereClause = "";
      let selectedFields: string[] | null = null;
      let limitVal = 100;

      const chain = {
        where: (clause: string) => {
          whereClause = clause;
          return chain;
        },
        select: (fields: string[]) => {
          selectedFields = fields;
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

function makeRow(symbol: string, file: string, line: number, refs: string[] = []) {
  return {
    path: file,
    start_line: line,
    defined_symbols: [symbol],
    referenced_symbols: refs,
    role: "ORCHESTRATION",
    parent_symbol: null,
    complexity: 5,
    content: `import { ${symbol} } from "./${file}"`,
  };
}

describe("GraphBuilder", () => {
  it("buildGraph returns center with callers and callees", async () => {
    const db = createMockDb({
      "defined_symbols, 'handleAuth'": [makeRow("handleAuth", "/src/auth.ts", 10, ["validate", "respond"])],
      "referenced_symbols, 'handleAuth'": [makeRow("router", "/src/router.ts", 5, ["handleAuth"])],
      "defined_symbols, 'validate'": [makeRow("validate", "/src/jwt.ts", 20)],
      "defined_symbols, 'respond'": [makeRow("respond", "/src/response.ts", 30)],
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
      "import": [
        { path: "/src/commands/mcp.ts", content: 'import { VectorDB } from "../store"' },
        { path: "/src/index.ts", content: 'import { VectorDB } from "./db"' },
        { path: "/src/store.ts", content: "export class VectorDB {}" },
      ],
    });
    const builder = new GraphBuilder(db);
    const importers = await builder.getImporters("VectorDB");

    expect(importers.length).toBe(3);
    expect(importers).toContain("/src/commands/mcp.ts");
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
});
