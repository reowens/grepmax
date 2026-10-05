import { describe, expect, it, vi } from "vitest";
import { evaluateCase } from "../src/eval";
import { evaluateOss } from "../src/eval-oss";
import type { ChunkType, SearchResponse } from "../src/lib/store/types";

// These regressions exercise scoring only, with no store or embedding work.
vi.mock("../src/lib/search/searcher", () => ({
  Searcher: vi.fn(() => {
    throw new Error("Scoring tests must not start searches");
  }),
}));
vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(() => {
    throw new Error("Scoring tests must not open an index");
  }),
}));

const internalCase = {
  query: "where is the target handler",
  expectedPath: "src/target.ts",
};
const ossCase = {
  id: "synthetic-target",
  query: "targetHandler",
  expectedFile: "src/target.ts",
  expectedLine: 101,
};

function chunk(file: string, symbols: string[] = []): ChunkType {
  return {
    type: "text",
    score: 1,
    metadata: { path: `/synthetic/${file}`, hash: "fixture" },
    generated_metadata: { start_line: 0, num_lines: 1 },
    defined_symbols: symbols,
  };
}

function responseAt(rank: number): SearchResponse {
  const data = Array.from({ length: 20 }, (_, i) =>
    chunk(`src/irrelevant-${i}.ts`),
  );
  if (rank > 0) {
    data[rank - 1] = chunk("src/target.ts", [ossCase.query]);
  }
  return { data };
}

const cutoffs = [
  { rank: 1, rr: 1, recall: 1 },
  { rank: 10, rr: 0.1, recall: 1 },
  { rank: 11, rr: 0, recall: 0 },
  { rank: 20, rr: 0, recall: 0 },
  { rank: 0, rr: 0, recall: 0 },
];

describe("retrieval MRR@10", () => {
  it.each(cutoffs)("internal reciprocal rank at position $rank", (c) => {
    const result = evaluateCase(responseAt(c.rank), internalCase, 7);
    expect(result.rr).toBe(c.rr);
    expect(result.recall).toBe(c.recall);
    expect(result.found).toBe(c.rank > 0);
    expect(result.rank).toBe(c.rank);
    expect(result.timeMs).toBe(7);
  });

  it.each(cutoffs)("OSS reciprocal rank at position $rank", (c) => {
    const result = evaluateOss(responseAt(c.rank), ossCase, 7);
    expect(result.rr).toBe(c.rr);
    expect(result.recall10).toBe(c.recall);
    expect(result.rank).toBe(c.rank);
    expect(result.timeMs).toBe(7);
  });

  it("averages cutoff credit across all cases, including late hits and misses", () => {
    const internal = cutoffs.map((c) =>
      evaluateCase(responseAt(c.rank), internalCase, 0),
    );
    const oss = cutoffs.map((c) => evaluateOss(responseAt(c.rank), ossCase, 0));
    for (const results of [internal, oss]) {
      const mean = results.reduce((sum, r) => sum + r.rr, 0) / results.length;
      expect(mean).toBeCloseTo(0.22, 12);
    }
    expect(internal.filter((r) => r.found)).toHaveLength(4);
    expect(oss.filter((r) => r.rank > 0)).toHaveLength(4);
  });

  it("scores the first matching result when the target appears more than once", () => {
    const response = responseAt(11);
    response.data[9] = response.data[10];
    expect(evaluateCase(response, internalCase, 0).rr).toBe(0.1);
    expect(evaluateOss(response, ossCase, 0).rr).toBe(0.1);
  });

  it("scores empty responses as misses in both harnesses", () => {
    expect(evaluateCase({ data: [] }, internalCase, 0)).toMatchObject({
      rank: 0,
      found: false,
      rr: 0,
      recall: 0,
    });
    expect(evaluateOss({ data: [] }, ossCase, 0)).toMatchObject({
      rank: 0,
      rr: 0,
      recall10: 0,
    });
  });

  it.each([1, 9, 10])("rejects an internal avoided path at rank %i", (rank) => {
    const response = responseAt(10);
    response.data[rank - 1] = chunk("src/avoid.ts");
    expect(
      evaluateCase(response, { ...internalCase, avoidPath: "src/avoid.ts" }, 0),
    ).toMatchObject({ found: false, rr: 0, recall: 0 });
  });

  it("keeps credit when the avoided path ranks below the target", () => {
    const response = responseAt(10);
    response.data[10] = chunk("src/avoid.ts");
    expect(
      evaluateCase(response, { ...internalCase, avoidPath: "src/avoid.ts" }, 0),
    ).toMatchObject({ found: true, rr: 0.1, recall: 1 });
  });

  it("matches alternate internal target paths", () => {
    expect(
      evaluateCase(
        responseAt(10),
        { ...internalCase, expectedPath: "src/other.ts | SRC/TARGET.TS" },
        0,
      ),
    ).toMatchObject({ found: true, rr: 0.1, recall: 1 });
  });

  it.each([10, 11])("preserves OSS line-range matching at rank %i", (rank) => {
    const response = responseAt(rank);
    response.data[rank - 1] = {
      ...chunk("src/target.ts"),
      generated_metadata: { start_line: 100, num_lines: 1 },
    };
    expect(evaluateOss(response, ossCase, 0)).toMatchObject({
      rank,
      rr: rank === 10 ? 0.1 : 0,
      recall10: rank === 10 ? 1 : 0,
    });
  });

  it("requires the OSS target file as well as a matching symbol", () => {
    const response = responseAt(0);
    response.data[0] = chunk("src/unrelated.ts", [ossCase.query]);
    expect(evaluateOss(response, ossCase, 0)).toMatchObject({
      rank: 0,
      rr: 0,
      recall10: 0,
    });
  });
});
