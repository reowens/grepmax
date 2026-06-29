import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/lib/graph/graph-builder";
import { TreeSitterChunker } from "../src/lib/index/chunker";

/**
 * Member-call edges (`obj.method()`), CHUNKER_VERSION 4. Recorded ADDITIVELY:
 * a member-called name lands in `member_referenced_symbols` AND stays in
 * `referenced_symbols`. Two invariants:
 *   1. Substrate exists: member calls are tagged in member_referenced_symbols,
 *      free calls are not — the signal a future receiver-aware resolver needs.
 *   2. No recall loss: because member names remain in referenced_symbols,
 *      getCallers still finds member callers exactly as before (this is option
 *      (a), NOT the split — the split would REMOVE them and lose ~45% of edges).
 * Pure chunking + in-memory graph: no worker pool, no embeddings, no LanceDB.
 */

type Row = {
  path: string;
  start_line: number;
  defined_symbols: string[];
  referenced_symbols: string[];
  member_referenced_symbols: string[];
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
    member_referenced_symbols: c.memberReferencedSymbols ?? [],
    role: c.role ?? "IMPLEMENTATION",
    parent_symbol: c.parentSymbol ?? null,
    complexity: c.complexity ?? 1,
    content: c.content,
  }));
}

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

const TS_SOURCE = `import { helper } from "./util";

export function run(): number {
  helper();
  this.db.ensureTable();
  this.db.ensureTable();
  return 1;
}
`;

describe("member-call edges are recorded additively (no recall loss)", () => {
  it("tags member calls in member_referenced_symbols but keeps them in referenced_symbols", async () => {
    const chunker = new TreeSitterChunker();
    const rows = await chunkToRows(chunker, "run.ts", TS_SOURCE);
    const run = rows.find((r) => r.defined_symbols.includes("run"));
    expect(run).toBeDefined();

    // `this.db.ensureTable()` is a member call → tagged …
    expect(run!.member_referenced_symbols).toContain("ensureTable");
    // … and ALSO still in referenced_symbols (additive — recall preserved).
    expect(run!.referenced_symbols).toContain("ensureTable");

    // `helper()` is a free call → in referenced_symbols, NOT a member.
    expect(run!.referenced_symbols).toContain("helper");
    expect(run!.member_referenced_symbols).not.toContain("helper");
  });

  it("dedupes the member list (two .ensureTable() calls → one entry)", async () => {
    const chunker = new TreeSitterChunker();
    const rows = await chunkToRows(chunker, "run.ts", TS_SOURCE);
    const run = rows.find((r) => r.defined_symbols.includes("run"));
    const hits = run!.member_referenced_symbols.filter(
      (s) => s === "ensureTable",
    );
    expect(hits).toHaveLength(1);
  });

  it("getCallers still finds a member-only caller (option a, not the split)", async () => {
    const chunker = new TreeSitterChunker();
    const rows = [
      ...(await chunkToRows(
        chunker,
        "db.ts",
        `export class Db {\n  ensureTable(): number { return 1; }\n}\n`,
      )),
      ...(await chunkToRows(chunker, "run.ts", TS_SOURCE)),
    ];
    const builder = new GraphBuilder(createIndexDb(rows));
    const callers = await builder.callersOf("ensureTable");
    // The split would lose this (member-only caller); additive recording keeps it.
    expect(callers).toContain("run");
  });

  it("captures Python attribute calls (obj.attr()) as members", async () => {
    const chunker = new TreeSitterChunker();
    const source = `def go(self):
    helper()
    self.engine.compute()
    return 1
`;
    const rows = await chunkToRows(chunker, "svc.py", source);
    const go = rows.find((r) => r.defined_symbols.includes("go"));
    expect(go).toBeDefined();
    expect(go!.member_referenced_symbols).toContain("compute");
    expect(go!.referenced_symbols).toContain("compute");
    expect(go!.member_referenced_symbols).not.toContain("helper");
  });
});
