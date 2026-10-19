import "./isolated-host-policy";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { GraphBuilder } from "../src/lib/graph/graph-builder";
import { GraphWorkBudget } from "../src/lib/graph/work-budget";
import type { VectorRecord } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";

it("shares row and node ceilings with real native Arrow/query results", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-g2-native-"));
  const db = new VectorDB(path.join(dir, "db"), 4);
  const record = (symbol: string, refs: string[]): VectorRecord => ({
    id: symbol,
    path: `/proj/${symbol}.ts`,
    hash: symbol,
    content: symbol,
    start_line: 0,
    end_line: 1,
    is_exported: true,
    defined_symbols: [symbol],
    referenced_symbols: refs,
    member_referenced_symbols: [],
    type_referenced_symbols: [],
    role: "function",
    vector: [1, 0, 0, 0],
    colbert: [],
    colbert_scale: 1,
    pooled_colbert_48d: new Array(48).fill(0),
    doc_token_ids: [],
  });
  try {
    await db.insertBatch([
      record("root", []),
      ...Array.from({ length: 120 }, (_, i) => record(`caller${i}`, ["root"])),
    ]);
    const work = new GraphWorkBudget({ visitedNodes: 10, fetchedRows: 40 });
    const hits = await new GraphBuilder(db).getNeighbors(
      "root",
      "callers",
      3,
      work,
    );
    expect(hits).toHaveLength(9);
    expect(new Set(hits.map((h) => h.symbol)).size).toBe(9);
    expect(work.snapshot()).toMatchObject({
      status: "partial",
      outcome: "budget_limit",
      counts: {
        visitedNodes: 10,
        fetchedRows: 40,
        queries: 2,
        expansions: 1,
        resultNodes: 9,
      },
    });
    expect(work.snapshot().reasons).toContain("visitedNodes_limit");
    expect(work.snapshot().reasons).toContain("fetchedRows_limit");
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
