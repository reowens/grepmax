import { describe, expect, it } from "vitest";
import { packByBudget } from "../src/lib/utils/budget-pack";

describe("packByBudget", () => {
  it("knapsack-continue: skips an oversized chunk and fills with smaller ones", () => {
    // The real-world case from the Phase 4 premise check: a mid-ranked verbose
    // chunk busts the budget; the old greedy `break` would stop here and waste
    // the tail. Packing skips it and fits the smaller, still-relevant chunks.
    const candidates = [
      { tokens: 256, score: 1.0 }, // R1
      { tokens: 624, score: 0.9 }, // R2  (R1+R2 = 880)
      { tokens: 634, score: 0.8 }, // R3  busts 1500 (880+634=1514)
      { tokens: 271, score: 0.7 }, // R4  fits (880+271=1151)
      { tokens: 344, score: 0.6 }, // R5  fits (1151+344=1495)
    ];
    const pack = packByBudget(candidates, 1500);
    expect(pack.selected).toEqual([0, 1, 3, 4]); // R3 skipped, R4/R5 kept
    expect(pack.tokensUsed).toBe(1495);
    expect(pack.dropped).toBe(1);
  });

  it("returns selected indices in original relevance order, not packing order", () => {
    const candidates = [
      { tokens: 900, score: 1.0 },
      { tokens: 100, score: 0.5 },
      { tokens: 100, score: 0.4 },
    ];
    const pack = packByBudget(candidates, 1100);
    // All fit; order is the input order regardless of internal sort.
    expect(pack.selected).toEqual([0, 1, 2]);
  });

  it("density tiebreaker only reorders within near-score ties", () => {
    // Two near-tied scores (within eps): the denser (fewer-token) one is chosen
    // first, letting both fit; the clearly-lower chunk is dropped.
    const candidates = [
      { tokens: 800, score: 0.9 }, // A
      { tokens: 200, score: 0.895 }, // B near-tied with A but denser
      { tokens: 400, score: 0.5 }, // C lower
    ];
    const pack = packByBudget(candidates, 1000, { tieEpsilon: 0.02 });
    // A(800)+B(200)=1000 fit; C dropped.
    expect(pack.selected).toEqual([0, 1]);
    expect(pack.dropped).toBe(1);
  });

  it("does NOT bury a clearly-more-relevant large chunk under a small tangential one", () => {
    // Scores far apart (> eps) → no tiebreak; pure relevance wins the budget.
    const candidates = [
      { tokens: 900, score: 1.0 }, // dominant relevance, large
      { tokens: 100, score: 0.3 }, // tiny but barely relevant
    ];
    const pack = packByBudget(candidates, 950, { tieEpsilon: 0.02 });
    expect(pack.selected).toEqual([0]); // the relevant one, not the small one
  });

  it("atLeastOne guarantees the top hit even when it busts the budget", () => {
    const candidates = [
      { tokens: 5000, score: 0.9 },
      { tokens: 4000, score: 1.0 },
    ];
    const pack = packByBudget(candidates, 1000); // atLeastOne defaults true
    expect(pack.selected).toEqual([1]); // highest score, despite overflow
    expect(pack.tokensUsed).toBe(4000);
  });

  it("atLeastOne:false yields an empty selection when nothing fits", () => {
    const pack = packByBudget([{ tokens: 5000, score: 1 }], 1000, {
      atLeastOne: false,
    });
    expect(pack.selected).toEqual([]);
    expect(pack.dropped).toBe(1);
  });

  it("handles the empty candidate list", () => {
    expect(packByBudget([], 1000)).toEqual({
      selected: [],
      tokensUsed: 0,
      dropped: 0,
    });
  });
});
