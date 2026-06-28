/**
 * Aider-style chat/file seeding (Phase 4) — pure scoring helpers.
 *
 * Seeding biases search toward the agent's *working context*: files it has open
 * ("chat files", weighted heavily in Aider's repo-map) and identifiers it is
 * discussing. gmax applies the bias in **candidate generation** — it bumps the
 * Reciprocal Rank Fusion score of seed-matching candidates — NOT as a post-hoc
 * rerank tiebreaker. Bundle B (see docs/plans/2026-05-25-semantic-search-
 * landscape.md) showed a tiebreaker over a saturated rerank pool is a no-op;
 * lifting the fusion score instead lets a seeded candidate climb through the
 * stage-1 cosine cut, the stage-2 window, and the final ordering in one move,
 * and can even *recover* a candidate that fusion alone buried below the display
 * cut (something a rerank-only seed could never do).
 *
 * THE SAFETY INVARIANT. Seeding must never inject *off-topic* context: an agent
 * working in `pool.ts` who searches for "rank fusion scoring" should still get
 * `searcher.ts`, because `pool.ts` has nothing relevant to say. So the bonus is
 * **relevance-gated** — a seed match is only boosted when the candidate already
 * ranked highly in at least one retriever (vector OR full-text). A genuinely
 * on-topic seed chunk surfaces near the top of some retriever; an off-topic one
 * sits deep in every retriever and is left exactly where the query put it. We
 * gate on retriever rank (always available, even for an FTS-only hit) rather
 * than pooled-ColBERT cosine, which is not reliably populated on every index.
 *
 * All functions here are pure so the gating/weighting math can be unit-tested
 * (tests/seed-weight.test.ts) independently of the LanceDB-backed searcher.
 */

export interface SeedSpec {
  /** Paths the agent has open (any form — normalized to lowercase suffixes). */
  files?: string[];
  /** Identifiers the agent is discussing. */
  symbols?: string[];
}

export interface SeedContext {
  /** Lowercased path suffixes to match against candidate paths. */
  fileSuffixes: string[];
  /** Symbol names to match against candidate defined/referenced symbols. */
  symbols: Set<string>;
  /** True when at least one seed file or symbol was supplied. */
  active: boolean;
}

export interface SeedWeightParams {
  /** RRF-score bonus added for a seed-file match (env GMAX_SEED_FILE_W). */
  fileWeight: number;
  /**
   * RRF-score bonus when a candidate DEFINES a seed symbol (env
   * GMAX_SEED_SYMBOL_DEF_W). Definition-preferring: discussing symbol `X`
   * routes to where `X` is defined, not merely every caller of it.
   */
  symbolDefWeight: number;
  /**
   * RRF-score bonus when a candidate only REFERENCES a seed symbol (env
   * GMAX_SEED_SYMBOL_REF_W). Smaller than the def weight — callers are useful
   * context but should not outrank the definition.
   */
  symbolRefWeight: number;
  /**
   * Best-retriever-rank ceiling (1-indexed). A seed match is only boosted when
   * it reached at least this rank in the vector OR full-text retriever. Gates
   * out off-topic seed-file chunks that sit deep in every retriever.
   * (env GMAX_SEED_MAX_RANK)
   */
  maxRank: number;
}

export const DEFAULT_SEED_PARAMS: SeedWeightParams = {
  // RRF scores live around 1/(60+rank) ≈ 0.008–0.016, so a ~0.02 bonus is
  // strong enough to lift a genuinely-relevant seed match several ranks while
  // staying in the same order of magnitude as the fusion signal it augments.
  fileWeight: 0.02,
  symbolDefWeight: 0.02,
  symbolRefWeight: 0.006,
  // A genuinely on-topic seed chunk reaches the top handful of some retriever
  // (the route/recover fixtures land at ranks 1–7); an off-topic one sits mid-
  // pool or deeper (an irrelevant express seed file is rank ~150 for an
  // unrelated query). 8 is the eligibility ceiling separating the two without
  // boosting mid-pool noise (see tests/seed-weight.test.ts and eval-seed.ts).
  maxRank: 8,
};

/** Resolve params from env, falling back to DEFAULT_SEED_PARAMS per field. */
export function seedParamsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SeedWeightParams {
  const num = (
    raw: string | undefined,
    fallback: number,
    min: number,
  ): number => {
    const v = Number.parseFloat(raw ?? "");
    return Number.isFinite(v) && v >= min ? v : fallback;
  };
  return {
    fileWeight: num(env.GMAX_SEED_FILE_W, DEFAULT_SEED_PARAMS.fileWeight, 0),
    symbolDefWeight: num(
      env.GMAX_SEED_SYMBOL_DEF_W,
      DEFAULT_SEED_PARAMS.symbolDefWeight,
      0,
    ),
    symbolRefWeight: num(
      env.GMAX_SEED_SYMBOL_REF_W,
      DEFAULT_SEED_PARAMS.symbolRefWeight,
      0,
    ),
    maxRank: num(env.GMAX_SEED_MAX_RANK, DEFAULT_SEED_PARAMS.maxRank, 1),
  };
}

/** Normalize a seed spec into a matchable context. */
export function buildSeedContext(spec?: SeedSpec): SeedContext {
  const fileSuffixes = (spec?.files ?? [])
    .map((f) =>
      f
        .trim()
        .toLowerCase()
        .replace(/^\.?\//, ""),
    )
    .filter((f) => f.length > 0);
  const symbols = new Set(
    (spec?.symbols ?? []).map((s) => s.trim()).filter((s) => s.length > 0),
  );
  return {
    fileSuffixes,
    symbols,
    active: fileSuffixes.length > 0 || symbols.size > 0,
  };
}

export interface SeedMatch {
  file: boolean;
  /** Candidate defines a seed symbol. */
  symbolDef: boolean;
  /** Candidate references (but does not define) a seed symbol. */
  symbolRef: boolean;
}

/** Does a candidate match any seed file (by path suffix)? */
export function matchesSeedFile(
  ctx: SeedContext,
  candidatePath: string,
): boolean {
  if (ctx.fileSuffixes.length === 0) return false;
  const p = candidatePath.toLowerCase();
  return ctx.fileSuffixes.some(
    (suffix) => p.endsWith(`/${suffix}`) || p === suffix || p.endsWith(suffix),
  );
}

/**
 * Classify a candidate's relationship to the seed symbols: does it define one,
 * or merely reference one? Definition wins when both are true.
 */
export function matchesSeedSymbol(
  ctx: SeedContext,
  definedSymbols: readonly string[],
  referencedSymbols: readonly string[],
): { def: boolean; ref: boolean } {
  if (ctx.symbols.size === 0) return { def: false, ref: false };
  let def = false;
  for (const s of definedSymbols) {
    if (ctx.symbols.has(s)) {
      def = true;
      break;
    }
  }
  let ref = false;
  for (const s of referencedSymbols) {
    if (ctx.symbols.has(s)) {
      ref = true;
      break;
    }
  }
  return { def, ref };
}

/**
 * The additive RRF-score bonus for a candidate. Returns 0 when the candidate
 * matches no seed, or when it matches but its best retriever rank is deeper
 * than the ceiling (the safety invariant). `bestRank` is the 1-indexed best
 * position the candidate reached across retrievers; 0/Infinity means it was
 * never retrieved near the top and is therefore ineligible. File and symbol
 * bonuses are additive; a definition match supersedes a reference match.
 */
export function seedBoost(
  match: SeedMatch,
  bestRank: number,
  params: SeedWeightParams,
): number {
  if (!match.file && !match.symbolDef && !match.symbolRef) return 0;
  if (!(bestRank >= 1) || bestRank > params.maxRank) return 0;
  let bonus = match.file ? params.fileWeight : 0;
  if (match.symbolDef) bonus += params.symbolDefWeight;
  else if (match.symbolRef) bonus += params.symbolRefWeight;
  return bonus;
}
