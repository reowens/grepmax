import type { GraphBuilder } from "../graph/graph-builder";
import { findTests } from "../graph/impact";
import { extractDiff, extractSymbols, fileChurn } from "../llm/diff";
import type { VectorDB } from "../store/vector-db";

// Phase 8 — diff-aware risk preamble. A deterministic, LLM-free ranking of the
// symbols a change touches by how dangerous they are to break: blast radius
// (how many callers depend on them) amplified when there's no test safety net
// and when the file churns a lot. Mirrors Sverklo's review_diff
// `importance × test-coverage × churn`, using gmax's own graph edges (now
// accurate across grammars after Phase 1) instead of a PageRank signal.

export interface RiskInput {
  symbol: string;
  /** Defining location, root-relative when resolvable. */
  file: string;
  line: number;
  /** Distinct inbound callers — blast radius. */
  callerCount: number;
  /** Whether any test exercises the symbol. */
  hasTests: boolean;
  /** Commits touching the defining file across history. */
  churn: number;
}

export interface RiskRow extends RiskInput {
  score: number;
}

// No test safety net → treat the change as twice as risky. A single, named
// constant keeps the score explainable rather than a tuned black box.
const UNTESTED_MULTIPLIER = 2;

/**
 * Score and rank changed symbols, riskiest first. Pure — no I/O — so the
 * ranking logic is unit-tested without a graph or git. Score is
 * `(callers + 1) × testFactor × churnFactor`: blast radius dominates, the
 * untested penalty doubles it, and churn contributes on a log scale so a
 * very churny file nudges rather than swamps the ranking.
 */
export function computeRiskTable(inputs: RiskInput[]): RiskRow[] {
  const rows = inputs.map((r) => {
    const blast = r.callerCount + 1; // +1 so a zero-caller symbol still scores
    const testFactor = r.hasTests ? 1 : UNTESTED_MULTIPLIER;
    const churnFactor = 1 + Math.log2(r.churn + 1);
    const score = Math.round(blast * testFactor * churnFactor * 100) / 100;
    return { ...r, score };
  });
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.callerCount - a.callerCount ||
      a.symbol.localeCompare(b.symbol),
  );
  return rows;
}

/** Render the ranking — TSV-ish for agents, an aligned table for humans. */
export function formatRiskTable(
  rows: RiskRow[],
  opts: { agent: boolean },
): string {
  if (rows.length === 0) {
    return opts.agent ? "(no changed symbols)" : "No changed symbols to rank.";
  }

  if (opts.agent) {
    return rows
      .map(
        (r) =>
          `risk\t${r.score}\t${r.symbol}\t${r.file}:${r.line}\tcallers=${r.callerCount}\ttests=${r.hasTests ? "y" : "n"}\tchurn=${r.churn}`,
      )
      .join("\n");
  }

  const lines = rows.map((r) => {
    const flag = !r.hasTests && r.callerCount > 0 ? "  ⚠ untested" : "";
    return `  ${String(r.score).padStart(7)}  ${r.symbol}  (${r.callerCount} callers, ${r.hasTests ? "tested" : "no tests"}, churn ${r.churn})  ${r.file}:${r.line}${flag}`;
  });
  return `Risk ranking — blast radius × tests × churn (riskiest first):\n${lines.join("\n")}`;
}

/**
 * Gather risk inputs for the symbols a ref's diff touches. Impure: reads git
 * (diff + churn) and the graph (callers + defining location + tests). Each
 * symbol is independent, so failures degrade that row rather than the whole
 * table.
 */
export async function gatherRiskInputs(
  ref: string,
  projectRoot: string,
  deps: { vectorDb: VectorDB; graphBuilder: GraphBuilder },
): Promise<RiskInput[]> {
  const diff = extractDiff(ref, projectRoot);
  if (!diff) return [];
  const symbols = extractSymbols(diff);
  if (symbols.length === 0) return [];

  const root = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  const relativize = (f: string) =>
    f.startsWith(root) ? f.slice(root.length) : f;

  const inputs = await Promise.all(
    symbols.map(async (symbol): Promise<RiskInput> => {
      const [callers, loc, tests] = await Promise.all([
        deps.graphBuilder.callersOf(symbol).catch(() => [] as string[]),
        deps.graphBuilder.resolveLocation(symbol).catch(() => null),
        findTests([symbol], deps.vectorDb, projectRoot).catch(() => []),
      ]);
      const file = loc?.file ?? "";
      return {
        symbol,
        file: file ? relativize(file) : "(unindexed)",
        line: loc?.line ?? 0,
        callerCount: callers.length,
        hasTests: tests.length > 0,
        churn: fileChurn(file, projectRoot),
      };
    }),
  );
  return inputs;
}
