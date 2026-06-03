/**
 * Token-aware budget packing (Phase 4).
 *
 * The budget-oriented output modes (`gmax context`, `gmax search
 * --context-for-llm --budget`) greedily emit results in relevance order until
 * the next chunk would overflow the token budget — then they STOP. That wastes
 * the tail: a single mid-ranked verbose chunk that busts the budget aborts the
 * whole loop, even when smaller, still-relevant chunks further down would fit.
 *
 * `packByBudget` fixes that with a knapsack-style greedy fill (skip the
 * oversized chunk, keep trying the rest) plus a *conservative* density
 * tiebreaker: among chunks whose relevance scores are within `tieEpsilon`, the
 * denser (fewer-token) chunk is preferred. The tiebreaker only reorders
 * near-ties, so it never buries a clearly-more-relevant chunk beneath a small
 * tangential one. Selected items are returned in their original relevance order
 * for display — packing is a selection concern, not a presentation one.
 *
 * This lives entirely in the presentation layer; it does NOT touch
 * `searcher.ts` ranking, so search relevance / the bench are unaffected.
 */

export interface BudgetCandidate {
  /** Estimated token cost of emitting this item. */
  tokens: number;
  /** Relevance score (higher = more relevant). */
  score: number;
}

export interface BudgetPackResult {
  /** Selected input indices, in original (relevance) order. */
  selected: number[];
  tokensUsed: number;
  /** How many candidates were left out for lack of budget. */
  dropped: number;
}

export interface BudgetPackOptions {
  /** Scores within this delta are treated as tied → denser one wins. */
  tieEpsilon?: number;
  /**
   * Guarantee the single highest-scoring candidate is included even if it alone
   * busts the budget (preserves "you always get the top hit" UX). Default true.
   */
  atLeastOne?: boolean;
}

export function packByBudget(
  candidates: BudgetCandidate[],
  budget: number,
  options: BudgetPackOptions = {},
): BudgetPackResult {
  const eps = options.tieEpsilon ?? 0.02;
  const atLeastOne = options.atLeastOne ?? true;

  if (candidates.length === 0) {
    return { selected: [], tokensUsed: 0, dropped: 0 };
  }

  // Selection order: higher score first, but bucket near-ties (within eps) so
  // the denser candidate wins inside a bucket. Bucketing keeps the comparator a
  // valid total order (a raw |Δscore|<eps test would be intransitive).
  const order = candidates
    .map((c, i) => ({ i, tokens: Math.max(0, c.tokens), score: c.score }))
    .sort((a, b) => {
      const ba = Math.round(a.score / eps);
      const bb = Math.round(b.score / eps);
      if (ba !== bb) return bb - ba; // higher score bucket first
      if (a.tokens !== b.tokens) return a.tokens - b.tokens; // denser first on tie
      return a.i - b.i; // stable
    });

  const selected: number[] = [];
  let used = 0;
  for (const o of order) {
    if (used + o.tokens > budget) continue; // skip oversized, keep filling
    selected.push(o.i);
    used += o.tokens;
  }

  if (selected.length === 0 && atLeastOne) {
    // Nothing fit — emit the single most relevant candidate anyway.
    let best = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].score > candidates[best].score) best = i;
    }
    selected.push(best);
    used = Math.max(0, candidates[best].tokens);
  }

  selected.sort((x, y) => x - y); // back to relevance/display order
  return {
    selected,
    tokensUsed: used,
    dropped: candidates.length - selected.length,
  };
}
