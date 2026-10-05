import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const read = vi.fn();
  const vectorSearch = () => {
    let limitVal = records.length;
    const chain = {
      select: () => chain,
      limit: (n: number) => {
        limitVal = n;
        return chain;
      },
      where: () => chain,
      toArray: async () => {
        read();
        return records.slice(0, limitVal);
      },
    };
    return chain;
  };

  const emptySearch = () => {
    const chain = {
      select: () => chain,
      limit: () => chain,
      where: () => chain,
      toArray: async (): Promise<VectorRecord[]> => {
        read();
        return [];
      },
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
        read();
        const ids = [...whereClause.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        const selected = ids.length
          ? records.filter((r) => r.id && ids.includes(r.id))
          : records;
        return selected.slice(0, limitVal);
      },
    };
    return chain;
  };

  return { vectorSearch, search: emptySearch, query, read };
}

describe("Searcher result window", () => {
  const records = Array.from({ length: 50 }, (_, i) => makeRecord(i));
  const pool = getWorkerPool() as any;

  beforeEach(() => {
    vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "0.7");
    vi.stubEnv("GMAX_STAGE1_K", "200");
    vi.stubEnv("GMAX_STAGE2_K", "40");
    vi.stubEnv("GMAX_RERANK_TOP", "20");
    vi.stubEnv("GMAX_MAX_PER_FILE", "3");
    pool.encodeQuery.mockResolvedValue({
      dense: Array(CONFIG.VECTOR_DIM).fill(0),
      colbert: [],
      colbertDim: CONFIG.COLBERT_DIM,
    });
    pool.rerank.mockResolvedValue(Array(20).fill(1));
    pool.rerank.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  function makeSearcher(input = records): Searcher {
    const table = makeTable(input);
    const db = {
      ensureTable: async () => table,
      adoptFTSIndex: async () => {},
      createFTSIndex: async () => {},
    };
    return new Searcher(db as any);
  }

  it("can return more results than RERANK_TOP", async () => {
    const result = await makeSearcher().search("query", 50, { rerank: false });

    expect(result.data).toHaveLength(50);
    expect(pool.rerank).not.toHaveBeenCalled();
  });
  it("keeps concurrent per-file overrides local and preserves the configured default", async () => {
    vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
    vi.stubEnv("GMAX_MAX_PER_FILE", "5");
    const input = records
      .slice(0, 10)
      .map((r) => ({ ...r, path: "/project/large.ts" }));
    const searcher = makeSearcher(input);
    const results = await Promise.all(
      [2, 6, undefined].map((maxPerFile) =>
        searcher.search("process incoming requests", 10, {
          maxPerFile,
          diagnostics: true,
        }),
      ),
    );
    expect(results.map((r) => r.data.length)).toEqual([2, 6, 5]);
    expect(results.map((r) => r.diagnostics?.settings.maxPerFile)).toEqual([
      2, 6, 5,
    ]);
    expect(process.env.GMAX_MAX_PER_FILE).toBe("5");
    expect(pool.rerank).not.toHaveBeenCalled();
    expect(
      (await searcher.search("process incoming requests", 4, { maxPerFile: 6 }))
        .data,
    ).toHaveLength(4);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "6", null])(
    "rejects invalid per-file override %s before database or worker activity",
    async (maxPerFile) => {
      const ensureTable = vi.fn();
      const searcher = new Searcher({ ensureTable } as any);
      pool.encodeQuery.mockClear();
      await expect(
        searcher.search("query", 10, { maxPerFile: maxPerFile as number }),
      ).rejects.toThrow("positive safe integer");
      expect(ensureTable).not.toHaveBeenCalled();
      expect(pool.encodeQuery).not.toHaveBeenCalled();
    },
  );

  it.each([1, 3])(
    "keeps the same leading ranks when requesting %i instead of ten results",
    async (limit) => {
      const input = records.map((record) => ({ ...record }));
      // At retrieval rank 25 this orchestrator is outside the old short-request
      // scoring window. It still deserves to compete under the existing boosts.
      input[24] = {
        ...input[24],
        is_anchor: false,
        role: "ORCHESTRATION",
        referenced_symbols: Array(16).fill("callee"),
      };
      const query = "cancel MCP requests and close daemon reads";
      const longer = await makeSearcher(input).search(query, 10, {
        rerank: false,
      });
      const shorter = await makeSearcher(input).search(query, limit, {
        rerank: false,
      });
      expect(longer.data[0].metadata?.path).toBe(input[24].path);
      expect(shorter.data.map((record) => record.metadata?.path)).toEqual(
        longer.data.slice(0, limit).map((record) => record.metadata?.path),
      );
      expect(pool.rerank).not.toHaveBeenCalled();
    },
  );

  it("keeps expensive rerank bounded to RERANK_TOP", async () => {
    await makeSearcher().search("query", 50, { rerank: true });

    expect(pool.rerank).toHaveBeenCalledOnce();
    expect(pool.rerank.mock.calls[0][0].docs).toHaveLength(20);
  });

  it("leaves results and database-read counts unchanged when diagnostics are requested", async () => {
    const table = makeTable(records);
    const searcher = new Searcher({
      ensureTable: async () => table,
      adoptFTSIndex: async () => {},
    } as any);
    const plain = await searcher.search("where requests are handled", 10, {
      explain: true,
    });
    const reads = table.read.mock.calls.length;
    table.read.mockClear();
    const traced = await searcher.search("where requests are handled", 10, {
      explain: true,
      diagnostics: true,
    });
    expect(traced.data).toEqual(plain.data);
    expect(traced.warnings).toEqual(plain.warnings);
    expect(plain.diagnostics).toBeUndefined();
    expect(table.read).toHaveBeenCalledTimes(reads);
    expect(traced.diagnostics?.fts).toEqual({
      available: true,
      searchFailed: false,
    });
    expect(traced.diagnostics?.gate).toMatchObject({
      requestedRerank: false,
      evaluated: true,
      activated: false,
      rerankInvoked: false,
    });
    // The fallback base score exists even when ColBERT was not called.
    expect(traced.data[0].scoreBreakdown?.rerank).toBeGreaterThan(0);
    expect(pool.rerank).not.toHaveBeenCalled();
    expect(traced.diagnostics?.trace.candidates[0]).toMatchObject({
      startLine: 1,
      endLine: 4,
      ranks: {
        vector: 1,
        fts: 0,
        rrf: 1,
        fusion: 1,
        stage1: 1,
        pooled: 1,
        rerank: 1,
        scored: 1,
        dedup: 1,
        final: 1,
      },
    });
    expect(JSON.stringify(traced.diagnostics)).not.toContain("export function");
    expect(traced.diagnostics?.trace.candidates[0].outcome).toBe("returned");
    expect(traced.diagnostics?.trace.candidates[10].outcome).toBe(
      "display-limit",
    );
  });

  it.each([false, true])(
    "distinguishes automatic gate activation from explicit rerank=%s",
    async (explicit) => {
      const input = records.slice(0, 10).map((r, i) => ({
        ...r,
        path: "/project/large.ts",
        start_line: i * 10,
        end_line: i * 10 + 3,
      }));
      const result = await makeSearcher(input).search(
        "process incoming requests",
        10,
        { rerank: explicit, diagnostics: true },
      );
      expect(result.diagnostics?.gate).toMatchObject({
        requestedRerank: explicit,
        evaluated: !explicit,
        activated: !explicit,
        share: explicit ? null : 1,
        rerankInvoked: true,
      });
      expect(pool.rerank).toHaveBeenCalledOnce();
    },
  );

  it("reports a disabled concentration gate without confusing batch membership with invocation", async () => {
    vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
    const input = records
      .slice(0, 10)
      .map((r) => ({ ...r, path: "/project/large.ts" }));
    const result = await makeSearcher(input).search(
      "process incoming requests",
      10,
      { diagnostics: true },
    );
    expect(result.diagnostics?.gate).toMatchObject({
      threshold: 2,
      evaluated: false,
      activated: false,
      rerankInvoked: false,
    });
    expect(result.diagnostics?.stages.rerank).toBe(10);
    expect(result.diagnostics?.stages.final).toBe(3);
    expect(result.diagnostics?.trace.candidates[3].outcome).toBe(
      "per-file-limit",
    );
    expect(result.diagnostics?.trace.candidates[3].ranks).toMatchObject({
      scored: 4,
      dedup: 4,
      final: 0,
    });
    expect(pool.rerank).not.toHaveBeenCalled();
  });

  it("bounds the trace and reports known pooled/stage-one exclusions", async () => {
    const input = Array.from({ length: 250 }, (_, i) => ({
      ...makeRecord(i),
      pooled_colbert_48d: [i + 1],
    }));
    pool.encodeQuery.mockResolvedValue({
      dense: [],
      colbert: [],
      colbertDim: CONFIG.COLBERT_DIM,
      pooled_colbert_48d: [1],
    });
    const result = await makeSearcher(input).search(
      "process incoming requests",
      10,
      { diagnostics: true },
    );
    expect(result.diagnostics?.trace).toMatchObject({
      total: 250,
      limit: 200,
      truncated: true,
    });
    expect(result.diagnostics?.trace.candidates).toHaveLength(200);
    expect(result.diagnostics?.stages).toMatchObject({
      vector: 250,
      fusion: 250,
      stage1: 200,
      pooled: 40,
      scored: 40,
    });
    expect(result.diagnostics?.settings.pooledFilterApplied).toBe(true);
    expect(result.diagnostics?.trace.candidates[0].outcome).toBe("pooled-cut");
    expect(result.diagnostics?.trace.candidates[0].ranks).toMatchObject({
      stage1: 1,
      pooled: 0,
      scored: 0,
    });
    expect(result.diagnostics?.trace.candidates[199].ranks.pooled).toBe(1);
  });

  it("identifies overlap deduplication independently of final trimming", async () => {
    const a = makeRecord(0);
    const b = {
      ...makeRecord(1),
      path: a.path,
      start_line: a.start_line,
      end_line: a.end_line,
    };
    const result = await makeSearcher([a, b]).search(
      "process incoming requests",
      10,
      { diagnostics: true },
    );
    expect(result.diagnostics?.trace.candidates[1].outcome).toBe(
      "deduplicated",
    );
    expect(result.diagnostics?.trace.candidates[1].ranks).toMatchObject({
      scored: 2,
      dedup: 0,
      final: 0,
    });
  });

  it("returns honest diagnostics for empty and degraded retrieval", async () => {
    const table = makeTable([]);
    const searcher = new Searcher({
      ensureTable: async () => table,
      adoptFTSIndex: async () => {
        throw new Error("not available");
      },
    } as any);
    const result = await searcher.search("process incoming requests", 10, {
      diagnostics: true,
    });
    expect(result.data).toEqual([]);
    expect(result.diagnostics?.fts).toEqual({
      available: false,
      searchFailed: false,
    });
    expect(result.diagnostics?.trace.candidates).toEqual([]);
    expect(result.diagnostics?.gate.rerankInvoked).toBe(false);
  });

  it("records FTS query failure while preserving vector results", async () => {
    const table = makeTable(records);
    const chain = {
      select: () => chain,
      limit: () => chain,
      where: () => chain,
      toArray: async () => {
        throw new Error("FTS failed");
      },
    };
    table.search = () => chain;
    const searcher = new Searcher({
      ensureTable: async () => table,
      adoptFTSIndex: async () => {},
    } as any);
    const result = await searcher.search("process incoming requests", 10, {
      diagnostics: true,
    });
    expect(result.data).toHaveLength(10);
    expect(result.diagnostics?.fts).toEqual({
      available: false,
      searchFailed: true,
    });
    expect(result.diagnostics?.stages).toMatchObject({ vector: 50, fts: 0 });
    expect(result.warnings).toHaveLength(1);
  });

  it("retains keyword-only membership and separates fusion from the stage-one cut", async () => {
    vi.stubEnv("GMAX_STAGE1_K", "2");
    const table = makeTable(records);
    const keywordOnly = makeRecord(99);
    const chain = {
      select: () => chain,
      limit: () => chain,
      where: () => chain,
      toArray: async () => [keywordOnly],
    };
    table.search = () => chain;
    const searcher = new Searcher({
      ensureTable: async () => table,
      adoptFTSIndex: async () => {},
    } as any);
    const result = await searcher.search("process incoming requests", 10, {
      diagnostics: true,
    });
    const keyword = result.diagnostics?.trace.candidates.find(
      (c) => c.id === keywordOnly.id,
    );
    expect(keyword?.ranks).toMatchObject({
      vector: 0,
      fts: 1,
      rrf: 2,
      fusion: 2,
      stage1: 2,
      final: 2,
    });
    expect(
      result.diagnostics?.trace.candidates.find((c) => c.id === records[1].id)
        ?.ranks,
    ).toMatchObject({ fusion: 3, stage1: 0, pooled: 0 });
    expect(
      result.diagnostics?.trace.candidates.find((c) => c.id === records[1].id)
        ?.outcome,
    ).toBe("stage1-cut");
    expect(result.diagnostics?.stages).toMatchObject({
      vector: 50,
      fts: 1,
      fusion: 51,
      stage1: 2,
    });
  });
});
