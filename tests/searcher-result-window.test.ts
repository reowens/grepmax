import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { Searcher } from "../src/lib/search/searcher";
import type { VectorRecord } from "../src/lib/store/types";
import { getWorkerPool } from "../src/lib/workers/pool";

function makeRecord(i: number): VectorRecord {
  return {
    id: `id-${i}`,
    path: `/project/src/file-${i}.ts`,
    hash: `hash-${i}`,
    content: `export function item${i}() { return ${i}; }`,
    display_text: `export function item${i}() { return ${i}; }`,
    start_line: i * 10,
    end_line: i * 10 + 3,
    vector: [],
    chunk_index: 0,
    is_anchor: true,
    context_prev: "",
    context_next: "",
    chunk_type: "function",
    complexity: 1,
    is_exported: false,
    colbert: Buffer.alloc(0),
    colbert_scale: 1,
    pooled_colbert_48d: [],
    doc_token_ids: [],
    defined_symbols: [],
    referenced_symbols: [],
    type_referenced_symbols: [],
    member_referenced_symbols: [],
    imports: [],
    exports: [],
    role: "IMPLEMENTATION",
    parent_symbol: "",
    file_skeleton: "",
    summary: "",
  };
}

function makeTable(records: VectorRecord[]) {
  const vectorSearch = () => {
    let limitVal = records.length;
    const chain = {
      select: () => chain,
      limit: (n: number) => {
        limitVal = n;
        return chain;
      },
      where: () => chain,
      toArray: async () => records.slice(0, limitVal),
    };
    return chain;
  };

  const emptySearch = () => {
    const chain = {
      select: () => chain,
      limit: () => chain,
      where: () => chain,
      toArray: async () => [],
    };
    return chain;
  };

  const query = () => {
    let whereClause = "";
    let limitVal = records.length;
    const chain = {
      select: () => chain,
      where: (where: string) => {
        whereClause = where;
        return chain;
      },
      limit: (n: number) => {
        limitVal = n;
        return chain;
      },
      toArray: async () => {
        const ids = [...whereClause.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        const selected = ids.length
          ? records.filter((r) => r.id && ids.includes(r.id))
          : records;
        return selected.slice(0, limitVal);
      },
    };
    return chain;
  };

  return { vectorSearch, search: emptySearch, query };
}

describe("Searcher result window", () => {
  const records = Array.from({ length: 50 }, (_, i) => makeRecord(i));
  const pool = getWorkerPool() as any;

  beforeEach(() => {
    pool.encodeQuery.mockResolvedValue({
      dense: Array(CONFIG.VECTOR_DIM).fill(0),
      colbert: [],
      colbertDim: CONFIG.COLBERT_DIM,
    });
    pool.rerank.mockResolvedValue(Array(20).fill(1));
    pool.rerank.mockClear();
  });

  function makeSearcher(): Searcher {
    const table = makeTable(records);
    const db = {
      ensureTable: async () => table,
      createFTSIndex: async () => {},
    };
    return new Searcher(db as any);
  }

  it("can return more results than RERANK_TOP", async () => {
    const result = await makeSearcher().search("query", 50, { rerank: false });

    expect(result.data).toHaveLength(50);
    expect(pool.rerank).not.toHaveBeenCalled();
  });

  it("keeps expensive rerank bounded to RERANK_TOP", async () => {
    await makeSearcher().search("query", 50, { rerank: true });

    expect(pool.rerank).toHaveBeenCalledOnce();
    expect(pool.rerank.mock.calls[0][0].docs).toHaveLength(20);
  });
});
