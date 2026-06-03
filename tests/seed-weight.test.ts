import { describe, expect, it } from "vitest";
import {
  buildSeedContext,
  DEFAULT_SEED_PARAMS,
  matchesSeedFile,
  matchesSeedSymbol,
  seedBoost,
  seedParamsFromEnv,
  type SeedMatch,
} from "../src/lib/search/seed-weight";

/**
 * Phase 4 — Aider-style chat/file seeding. The searcher bumps the RRF score of
 * candidates matching the agent's working context, gated by retriever rank so
 * off-topic seed files are never injected. These tests pin the pure
 * matching/gating/weighting math that decides what gets boosted and by how much.
 */

describe("buildSeedContext", () => {
  it("is inert with no seeds", () => {
    expect(buildSeedContext().active).toBe(false);
    expect(buildSeedContext({}).active).toBe(false);
    expect(buildSeedContext({ files: [], symbols: [] }).active).toBe(false);
  });

  it("normalizes file suffixes (lowercase, strips leading ./ and /)", () => {
    const ctx = buildSeedContext({ files: ["./src/Lib/Server.ts", "/abs/Path.ts", "  ", ""] });
    expect(ctx.fileSuffixes).toEqual(["src/lib/server.ts", "abs/path.ts"]);
    expect(ctx.active).toBe(true);
  });

  it("keeps symbols case-sensitive and drops blanks", () => {
    const ctx = buildSeedContext({ symbols: ["LlmServer", " ", "WorkerPool"] });
    expect([...ctx.symbols]).toEqual(["LlmServer", "WorkerPool"]);
  });
});

describe("matchesSeedFile", () => {
  const ctx = buildSeedContext({ files: ["src/lib/llm/server.ts"] });

  it("matches an absolute path by suffix", () => {
    expect(matchesSeedFile(ctx, "/Users/x/proj/src/lib/llm/server.ts")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesSeedFile(ctx, "/Users/x/proj/SRC/LIB/LLM/Server.ts")).toBe(true);
  });

  it("does not match a different file that merely shares a basename stem", () => {
    expect(matchesSeedFile(ctx, "/Users/x/proj/src/lib/http/server.ts")).toBe(false);
  });

  it("never matches when no files were seeded", () => {
    expect(matchesSeedFile(buildSeedContext({ symbols: ["X"] }), "/a/b.ts")).toBe(false);
  });
});

describe("matchesSeedSymbol", () => {
  const ctx = buildSeedContext({ symbols: ["LlmServer"] });

  it("flags a definition", () => {
    expect(matchesSeedSymbol(ctx, ["LlmServer"], [])).toEqual({ def: true, ref: false });
  });

  it("flags a reference", () => {
    expect(matchesSeedSymbol(ctx, ["Other"], ["LlmServer"])).toEqual({ def: false, ref: true });
  });

  it("reports both when a chunk defines and references", () => {
    expect(matchesSeedSymbol(ctx, ["LlmServer"], ["LlmServer"])).toEqual({ def: true, ref: true });
  });

  it("is empty when no symbols were seeded", () => {
    expect(matchesSeedSymbol(buildSeedContext({ files: ["a.ts"] }), ["LlmServer"], [])).toEqual({
      def: false,
      ref: false,
    });
  });
});

describe("seedBoost", () => {
  const P = DEFAULT_SEED_PARAMS;
  const m = (over: Partial<SeedMatch>): SeedMatch => ({
    file: false,
    symbolDef: false,
    symbolRef: false,
    ...over,
  });

  it("returns 0 for a non-match", () => {
    expect(seedBoost(m({}), 1, P)).toBe(0);
  });

  it("returns 0 when best rank is deeper than the ceiling (safety invariant)", () => {
    expect(seedBoost(m({ file: true }), P.maxRank + 1, P)).toBe(0);
  });

  it("returns 0 for an unranked candidate (0 / Infinity)", () => {
    expect(seedBoost(m({ file: true }), 0, P)).toBe(0);
    expect(seedBoost(m({ file: true }), Number.POSITIVE_INFINITY, P)).toBe(0);
  });

  it("boosts an eligible seed-file match", () => {
    expect(seedBoost(m({ file: true }), 1, P)).toBe(P.fileWeight);
    expect(seedBoost(m({ file: true }), P.maxRank, P)).toBe(P.fileWeight);
  });

  it("prefers definitions over references", () => {
    expect(seedBoost(m({ symbolDef: true }), 1, P)).toBe(P.symbolDefWeight);
    expect(seedBoost(m({ symbolRef: true }), 1, P)).toBe(P.symbolRefWeight);
    expect(P.symbolDefWeight).toBeGreaterThan(P.symbolRefWeight);
  });

  it("does not double-count def + ref, but adds file + symbol", () => {
    // def supersedes ref
    expect(seedBoost(m({ symbolDef: true, symbolRef: true }), 1, P)).toBe(P.symbolDefWeight);
    // file and symbol are additive
    expect(seedBoost(m({ file: true, symbolDef: true }), 1, P)).toBeCloseTo(
      P.fileWeight + P.symbolDefWeight,
    );
  });
});

describe("seedParamsFromEnv", () => {
  it("falls back to defaults on absent/invalid env", () => {
    expect(seedParamsFromEnv({})).toEqual(DEFAULT_SEED_PARAMS);
    expect(seedParamsFromEnv({ GMAX_SEED_MAX_RANK: "nope" })).toEqual(DEFAULT_SEED_PARAMS);
  });

  it("reads overrides", () => {
    const p = seedParamsFromEnv({
      GMAX_SEED_FILE_W: "0.05",
      GMAX_SEED_SYMBOL_DEF_W: "0.04",
      GMAX_SEED_SYMBOL_REF_W: "0.01",
      GMAX_SEED_MAX_RANK: "8",
    });
    expect(p).toEqual({ fileWeight: 0.05, symbolDefWeight: 0.04, symbolRefWeight: 0.01, maxRank: 8 });
  });

  it("rejects out-of-range values (maxRank must be ≥ 1)", () => {
    expect(seedParamsFromEnv({ GMAX_SEED_MAX_RANK: "0" }).maxRank).toBe(DEFAULT_SEED_PARAMS.maxRank);
    expect(seedParamsFromEnv({ GMAX_SEED_FILE_W: "-1" }).fileWeight).toBe(
      DEFAULT_SEED_PARAMS.fileWeight,
    );
  });
});
