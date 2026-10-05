import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  matchesTarget,
  parseFrozenFixture,
  type RelevanceCase,
  relevanceFixtureSchema,
  scoreRelevance,
  sha256,
  sourceExclusions,
  summarizeRelevance,
} from "../src/lib/eval/relevance-baseline";
import type { ChunkType } from "../src/lib/store/types";

const root = path.resolve("/fixture/repo");
const target = {
  file: "src/target.ts",
  symbol: "handleTarget",
  startLine: 20,
  endLine: 25,
  sourceSha256: "a".repeat(64),
};
const c: RelevanceCase = {
  id: "case-1",
  corpus: "repo",
  split: "heldout",
  origin: "curated-source",
  intent: "control",
  query: "where are failed requests retried",
  expected: [target],
};
const fixture = {
  schemaVersion: 1,
  createdAt: "2026-10-05",
  purpose: "test",
  corpora: [{ id: "repo", root, language: "ts" }],
  cases: [c],
};
function chunk(
  file = target.file,
  symbols: string[] = [target.symbol],
): ChunkType {
  return {
    type: "text",
    score: 1,
    metadata: { path: path.join(root, file), hash: target.sourceSha256 },
    defined_symbols: symbols,
  };
}

describe("frozen relevance fixtures", () => {
  it("rejects changed bytes even when the parsed JSON is equivalent", () => {
    const bytes = Buffer.from(JSON.stringify(fixture));
    expect(parseFrozenFixture(bytes, sha256(bytes)).cases[0].id).toBe(c.id);
    expect(() =>
      parseFrozenFixture(
        Buffer.concat([bytes, Buffer.from("\n")]),
        sha256(bytes),
      ),
    ).toThrow("checksum");
  });
  it.each([
    { ...fixture, cases: [c, c] },
    { ...fixture, corpora: [...fixture.corpora, ...fixture.corpora] },
    { ...fixture, cases: [{ ...c, corpus: "unknown" }] },
    {
      ...fixture,
      cases: [{ ...c, expected: [{ ...target, file: "../target.ts" }] }],
    },
    {
      ...fixture,
      cases: [
        { ...c, expected: [{ ...target, file: path.resolve("/target.ts") }] },
      ],
    },
    { ...fixture, cases: [{ ...c, expected: [{ ...target, endLine: 1 }] }] },
    {
      ...fixture,
      cases: [{ ...c, expected: [{ ...target, sourceSha256: "bad" }] }],
    },
  ])("rejects malformed identities and ground truth %#", (invalid) => {
    expect(relevanceFixtureSchema.safeParse(invalid).success).toBe(false);
  });
  it("separately records source changes and mismatched cache fingerprints", () => {
    expect(sourceExclusions("a", "a", "a")).toEqual([]);
    expect(sourceExclusions("a", "b", "a")).toEqual(["source_changed"]);
    expect(sourceExclusions("a", "a")).toEqual(["index_cache_hash_mismatch"]);
    expect(sourceExclusions("a", "b", "b")).toHaveLength(2);
  });
});

describe("strict target matching and cutoff", () => {
  it("requires exact file identity as well as the symbol", () => {
    expect(matchesTarget(chunk(), root, target)).toBe(true);
    expect(matchesTarget(chunk("src/unrelated.ts"), root, target)).toBe(false);
    expect(matchesTarget(chunk("src/my-target.ts"), root, target)).toBe(false);
    expect(matchesTarget(chunk(target.file, []), root, target)).toBe(false);
  });
  it.each([
    { start: 18, count: 2, hit: true },
    { start: 17, count: 2, hit: false },
    { start: 24, count: 1, hit: true },
    { start: 25, count: 1, hit: false },
    { start: 19, count: 0, hit: false },
  ])(
    "converts zero-based ranges without inventing missing windows %#",
    ({ start, count, hit }) => {
      expect(
        matchesTarget(
          {
            ...chunk(target.file, []),
            generated_metadata: { start_line: start, num_lines: count },
          },
          root,
          target,
        ),
      ).toBe(hit);
    },
  );
  it.each([1, 10, 11, 20, 0])(
    "scores raw rank %i with corrected MRR@10",
    (rank) => {
      const data = Array.from({ length: 20 }, () => chunk("src/other.ts"));
      if (rank) data[rank - 1] = chunk();
      expect(scoreRelevance({ data }, root, c)).toEqual({
        rank,
        found: rank > 0,
        hitAt1: rank === 1 ? 1 : 0,
        rrAt10: rank > 0 && rank <= 10 ? 1 / rank : 0,
        recallAt10: rank > 0 && rank <= 10 ? 1 : 0,
      });
    },
  );
  it("accepts an explicitly declared alternative, not a substring path", () => {
    const alt = { ...target, file: "src/alternative.ts" };
    expect(
      scoreRelevance({ data: [chunk(alt.file)] }, root, {
        ...c,
        expected: [target, alt],
      }).rank,
    ).toBe(1);
  });
});

describe("baseline aggregation", () => {
  it("distinguishes cases, repetitions, misses and invalid samples", () => {
    const base = {
      id: c.id,
      corpus: c.corpus,
      split: c.split,
      elapsedMs: 10,
      repetition: 1,
      exclusions: [],
    };
    const samples = [
      { ...base, rank: 10, rrAt10: 0.1, recallAt10: 1, hitAt1: 0, found: true },
      {
        ...base,
        repetition: 2,
        rank: 20,
        rrAt10: 0,
        recallAt10: 0,
        hitAt1: 0,
        found: true,
        elapsedMs: 100,
      },
      {
        ...base,
        id: "miss",
        rank: 0,
        rrAt10: 0,
        recallAt10: 0,
        hitAt1: 0,
        found: false,
        elapsedMs: 30,
      },
      {
        ...base,
        id: "stale",
        rank: 1,
        rrAt10: 1,
        recallAt10: 1,
        hitAt1: 1,
        found: true,
        exclusions: ["source_changed"],
      },
    ];
    expect(summarizeRelevance(samples)).toEqual({
      cases: 3,
      samples: 4,
      validSamples: 3,
      excludedSamples: 1,
      mrrAt10: 0.1 / 3,
      recallAt10: 1 / 3,
      hitsAt1: 0,
      medianMs: 30,
      p95Ms: 100,
    });
  });
  it("reports unavailable metrics when there are no valid samples", () => {
    expect(summarizeRelevance([])).toMatchObject({
      validSamples: 0,
      mrrAt10: null,
      recallAt10: null,
      medianMs: null,
      p95Ms: null,
    });
  });
});
