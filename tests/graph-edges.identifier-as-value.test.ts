import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/lib/graph/graph-builder";
import { TreeSitterChunker } from "../src/lib/index/chunker";

/**
 * End-to-end (minus embedding) proof that the chunker's identifier-as-value
 * edges flow through to the graph consumer that `trace --inbound` / `gmax dead`
 * rely on. Pure chunking + in-memory graph traversal: no worker pool, no
 * embedding model, no LanceDB. Before the chunker change, a caller that only
 * does `new BeyondError()` / `instanceof BeyondError` / `ErrorCodes.X` produced
 * NO `referenced_symbols` edge for those names, so `getCallers` returned empty.
 */

type Row = {
  path: string;
  start_line: number;
  defined_symbols: string[];
  referenced_symbols: string[];
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
    role: c.role ?? "IMPLEMENTATION",
    parent_symbol: c.parentSymbol ?? null,
    complexity: c.complexity ?? 1,
    content: c.content,
  }));
}

/**
 * Mock DB that faithfully evaluates the `array_contains(col, 'X')` predicate
 * (the only shape GraphBuilder emits) over a set of real-chunker rows.
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

const DEF_SOURCE = `export class BeyondError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export const ErrorCodes = {
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
} as const;
`;

const CALLER_SOURCE = `import { BeyondError, ErrorCodes } from "./errors";

export function handleRequest(x: unknown) {
  if (x instanceof BeyondError) {
    throw new BeyondError(ErrorCodes.VALIDATION, "invalid");
  }
  return ErrorCodes.NOT_FOUND;
}
`;

describe("identifier-as-value edges reach the graph consumer", () => {
  it("surfaces callers that only reference a class via new/instanceof", async () => {
    const chunker = new TreeSitterChunker();
    const rows = [
      ...(await chunkToRows(chunker, "errors.ts", DEF_SOURCE)),
      ...(await chunkToRows(chunker, "handler.ts", CALLER_SOURCE)),
    ];

    // The edge must exist in real chunker output (not just be assumed).
    const callerRow = rows.find((r) =>
      r.defined_symbols.includes("handleRequest"),
    );
    expect(callerRow).toBeDefined();
    expect(callerRow!.referenced_symbols).toContain("BeyondError");

    const builder = new GraphBuilder(createIndexDb(rows));
    const graph = await builder.buildGraph("BeyondError");

    expect(graph.center?.symbol).toBe("BeyondError");
    // `trace --inbound BeyondError` now finds the caller that does
    // `new BeyondError()` / `instanceof BeyondError` — previously empty.
    expect(graph.callers.map((c) => c.symbol)).toContain("handleRequest");
  });

  it("surfaces callers that reference an enum via member access", async () => {
    const chunker = new TreeSitterChunker();
    const rows = [
      ...(await chunkToRows(chunker, "errors.ts", DEF_SOURCE)),
      ...(await chunkToRows(chunker, "handler.ts", CALLER_SOURCE)),
    ];

    const builder = new GraphBuilder(createIndexDb(rows));
    const graph = await builder.buildGraph("ErrorCodes");

    expect(graph.center?.symbol).toBe("ErrorCodes");
    // `ErrorCodes.VALIDATION` / `ErrorCodes.NOT_FOUND` member access now yields
    // an inbound edge from the caller.
    expect(graph.callers.map((c) => c.symbol)).toContain("handleRequest");
  });
});
