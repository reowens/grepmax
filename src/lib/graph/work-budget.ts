/** Request-local traversal limits. Counts bound admitted work, not native scan
 * bytes, row width, or JavaScript event-loop scheduling latency. */
export const GRAPH_WORK_DEFAULTS = {
  visitedNodes: 500,
  queuedNodes: 500,
  resultNodes: 500,
  expansions: 500,
  examinedEdges: 10_000,
  symbolItems: 20_000,
  fetchedRows: 10_000,
  queries: 1_500,
  deadlineMs: 15_000,
} as const;

export type GraphWorkLimits = {
  -readonly [K in keyof typeof GRAPH_WORK_DEFAULTS]: number;
};
export type GraphWorkCounter = Exclude<keyof GraphWorkLimits, "deadlineMs">;
export interface GraphWorkSummary {
  version: 1;
  status: "complete" | "partial";
  outcome: "exhausted" | "hop_limit" | "target_found" | "budget_limit";
  reasons: string[];
  limits: GraphWorkLimits;
  /** queuedNodes is peak pending queue size; the other counters are cumulative. */
  counts: Record<GraphWorkCounter, number>;
}

export class GraphWorkBudget {
  readonly limits: GraphWorkLimits;
  readonly counts: Record<GraphWorkCounter, number> = {
    visitedNodes: 0,
    queuedNodes: 0,
    resultNodes: 0,
    expansions: 0,
    examinedEdges: 0,
    symbolItems: 0,
    fetchedRows: 0,
    queries: 0,
  };
  private readonly reasons = new Set<string>();
  private readonly deadline: number;
  private outcome: GraphWorkSummary["outcome"] = "exhausted";

  constructor(
    limits: Partial<GraphWorkLimits> = {},
    private readonly now = Date.now,
  ) {
    this.limits = { ...GRAPH_WORK_DEFAULTS };
    const ceilings = {
      ...GRAPH_WORK_DEFAULTS,
      visitedNodes: 1000,
      queuedNodes: 1000,
      resultNodes: 1000,
      expansions: 1000,
    };
    for (const key of Object.keys(this.limits) as Array<
      keyof GraphWorkLimits
    >) {
      const value = limits[key];
      // Internal overrides remain finite and clamped to absolute ceilings.
      // Paths retain their historical intended 1000-node ceiling; trace/BFS use 500.
      if (value !== undefined && Number.isFinite(value))
        this.limits[key] = Math.max(
          0,
          Math.min(Math.floor(value), ceilings[key]),
        );
    }
    this.deadline = now() + this.limits.deadlineMs;
  }

  static path(): GraphWorkBudget {
    return new GraphWorkBudget({
      visitedNodes: 1000,
      queuedNodes: 1000,
      resultNodes: 1000,
      expansions: 1000,
    });
  }

  partial(reason: string): void {
    this.reasons.add(reason);
  }
  remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }
  active(): boolean {
    if (this.remainingMs() <= 0) this.partial("deadline");
    return !this.reasons.has("deadline");
  }
  stopped(): boolean {
    return (
      !this.active() ||
      this.reasons.has("query_timeout") ||
      [...this.reasons].some(
        (reason) =>
          reason.endsWith("_limit") &&
          reason !== "hop_limit" &&
          reason !== "adjacency_row_limit",
      )
    );
  }
  remaining(counter: GraphWorkCounter): number {
    return this.limits[counter] - this.counts[counter];
  }
  take(counter: GraphWorkCounter, count = 1): boolean {
    if (counter !== "resultNodes" && !this.active()) return false;
    if (count > this.remaining(counter)) {
      this.partial(`${counter}_limit`);
      return false;
    }
    this.counts[counter] += count;
    return true;
  }
  queue(size: number): boolean {
    if (!this.active()) return false;
    if (size > this.limits.queuedNodes) {
      this.partial("queuedNodes_limit");
      return false;
    }
    this.counts.queuedNodes = Math.max(this.counts.queuedNodes, size);
    return true;
  }
  finish(outcome: GraphWorkSummary["outcome"]): void {
    this.outcome = outcome;
  }
  snapshot(): GraphWorkSummary {
    const reasons = [...this.reasons];
    const budgetLimited = reasons.some((r) => r !== "hop_limit");
    return {
      version: 1,
      status: reasons.length ? "partial" : "complete",
      outcome:
        this.outcome === "target_found"
          ? "target_found"
          : budgetLimited
            ? "budget_limit"
            : reasons.length
              ? "hop_limit"
              : this.outcome,
      reasons,
      limits: { ...this.limits },
      counts: { ...this.counts },
    };
  }
}

export function graphWorkNote(work?: GraphWorkSummary | null): string {
  if (!work) return "Traversal work coverage unknown (legacy producer).";
  return `Traversal ${work.status}: ${work.outcome}${work.reasons.length ? ` (${work.reasons.join(", ")})` : ""}; ${work.counts.visitedNodes} visited, ${work.counts.examinedEdges} edges examined, ${work.counts.fetchedRows} rows fetched, ${work.counts.queries} queries.`;
}
