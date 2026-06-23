import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/lib/graph/graph-builder";
import { TreeSitterChunker } from "../src/lib/index/chunker";

/**
 * Type-position reference edges (`: T`, `<T>`, `as T`, `interface X extends T`).
 * Two invariants:
 *   1. They reach the graph: `getCallers(T)` surfaces a file that uses T only in
 *      type position — what `trace --inbound` / `dead` need.
 *   2. They are SEPARATE from call edges: type refs land in
 *      `typeReferencedSymbols`, never `referencedSymbols`, so they can't inflate
 *      the call-edge count that drives role classification + search ranking.
 * Pure chunking + in-memory graph: no worker pool, no embeddings, no LanceDB.
 */

type Row = {
  path: string;
  start_line: number;
  defined_symbols: string[];
  referenced_symbols: string[];
  type_referenced_symbols: string[];
  role: string;
  parent_symbol: string | null;
  complexity: number;
  content: string;
};

async function chunkToRows(
  chunker: TreeSitterChunker,
  filePath: string,
  source: string,
): Promise<Row[]> {
  const { chunks } = await chunker.chunk(filePath, source);
  return chunks.map((c) => ({
    path: filePath,
    start_line: c.startLine,
    defined_symbols: c.definedSymbols ?? [],
    referenced_symbols: c.referencedSymbols ?? [],
    type_referenced_symbols: c.typeReferencedSymbols ?? [],
    role: c.role ?? "IMPLEMENTATION",
    parent_symbol: c.parentSymbol ?? null,
    complexity: c.complexity ?? 1,
    content: c.content,
  }));
}

/**
 * Mock DB that evaluates `array_contains(col, 'X')` predicates with OR
 * semantics — matching getCallers' `(array_contains(referenced_symbols, X) OR
 * array_contains(type_referenced_symbols, X))` union and the single-predicate
 * center/callee lookups alike.
 */
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
          const preds = [
            ...whereClause.matchAll(/array_contains\((\w+),\s*'([^']+)'\)/g),
          ];
          if (preds.length === 0) return rows.slice(0, limitVal);
          return rows
            .filter((r) =>
              preds.some(([, col, val]) =>
                ((r as any)[col] as string[] | undefined)?.includes(val),
              ),
            )
            .slice(0, limitVal);
        },
      };
      return chain;
    },
  };
  return { ensureTable: async () => table } as any;
}

const DEF_SOURCE = `export interface SearchResponse {
  data: number[];
}
export class VectorStore {
  size = 0;
}
`;

// SearchResponse appears ONLY in type position (param + return annotations).
// VectorStore appears both as a value (new) and as a type annotation.
const CALLER_SOURCE = `import type { SearchResponse } from "./types";
import { VectorStore } from "./store";

export function formatResp(resp: SearchResponse): SearchResponse {
  return resp;
}

export function makeStore(existing: VectorStore): VectorStore {
  return new VectorStore();
}
`;

describe("type-position edges reach the graph but stay out of call edges", () => {
  it("surfaces a caller that uses a type only in annotation position", async () => {
    const chunker = new TreeSitterChunker();
    const rows = [
      ...(await chunkToRows(chunker, "types.ts", DEF_SOURCE)),
      ...(await chunkToRows(chunker, "consumer.ts", CALLER_SOURCE)),
    ];

    const callerRow = rows.find((r) =>
      r.defined_symbols.includes("formatResp"),
    );
    expect(callerRow).toBeDefined();
    // Invariant 1: captured as a TYPE edge.
    expect(callerRow!.type_referenced_symbols).toContain("SearchResponse");
    // Invariant 2: NOT a call edge — must not inflate referenced_symbols.
    expect(callerRow!.referenced_symbols).not.toContain("SearchResponse");

    const builder = new GraphBuilder(createIndexDb(rows));
    const graph = await builder.buildGraph("SearchResponse");
    expect(graph.center?.symbol).toBe("SearchResponse");
    // `trace --inbound SearchResponse` / `dead SearchResponse` now see the
    // annotation-only consumer that the call graph alone missed.
    expect(graph.callers.map((c) => c.symbol)).toContain("formatResp");
  });

  it("keeps call sites in referenced_symbols, type sites in type_referenced_symbols", async () => {
    const chunker = new TreeSitterChunker();
    const rows = await chunkToRows(chunker, "consumer.ts", CALLER_SOURCE);
    const storeCaller = rows.find((r) =>
      r.defined_symbols.includes("makeStore"),
    );
    expect(storeCaller).toBeDefined();
    // `new VectorStore()` is a call/construct edge.
    expect(storeCaller!.referenced_symbols).toContain("VectorStore");
    // The `: VectorStore` annotations are type edges (deduped, separate list).
    expect(storeCaller!.type_referenced_symbols).toContain("VectorStore");
  });

  it("does not capture the definition's own name or type parameters", async () => {
    const chunker = new TreeSitterChunker();
    const source = `export interface Box<T> {
  value: T;
  meta: SearchResponse;
}
`;
    const rows = await chunkToRows(chunker, "box.ts", source);
    const boxRow = rows.find((r) => r.defined_symbols.includes("Box"));
    expect(boxRow).toBeDefined();
    // The type parameter T (declaration) and the interface's own name Box are
    // not references; the genuine type ref SearchResponse is.
    expect(boxRow!.type_referenced_symbols).toContain("SearchResponse");
    expect(boxRow!.type_referenced_symbols).not.toContain("T");
    expect(boxRow!.type_referenced_symbols).not.toContain("Box");
  });

  it("captures class heritage: `extends Base` (identifier) and `implements I`", async () => {
    const chunker = new TreeSitterChunker();
    const source = `import { Base } from "./base";
import type { Drawable } from "./drawable";

export class Widget extends Base implements Drawable {
  render(): number {
    return 1;
  }
}
`;
    const rows = await chunkToRows(chunker, "widget.ts", source);
    const widget = rows.find((r) => r.defined_symbols.includes("Widget"));
    expect(widget).toBeDefined();
    // `extends Base` — Base is an identifier (runtime value), captured via Shape 5.
    expect(widget!.type_referenced_symbols).toContain("Base");
    // `implements Drawable` — type_identifier, captured via Shape 4.
    expect(widget!.type_referenced_symbols).toContain("Drawable");
    // Neither is a call edge.
    expect(widget!.referenced_symbols).not.toContain("Base");
    expect(widget!.referenced_symbols).not.toContain("Drawable");
  });

  it("reduces a qualified superclass `extends ns.Base` to Base", async () => {
    const chunker = new TreeSitterChunker();
    const source = `import * as ns from "./ns";
export class Widget extends ns.Base {}
`;
    const rows = await chunkToRows(chunker, "widget.ts", source);
    const widget = rows.find((r) => r.defined_symbols.includes("Widget"));
    expect(widget).toBeDefined();
    expect(widget!.type_referenced_symbols).toContain("Base");
  });
});
