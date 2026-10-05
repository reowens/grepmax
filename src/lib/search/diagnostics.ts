import type {
  SearchDiagnostics,
  SearchStage,
  VectorRecord,
} from "../store/types";

const stages: SearchStage[] = [
  "vector",
  "fts",
  "rrf",
  "fusion",
  "stage1",
  "pooled",
  "rerank",
  "scored",
  "dedup",
  "final",
];
const rankingKeys = [
  "GMAX_PRE_K",
  "GMAX_STAGE1_K",
  "GMAX_STAGE2_K",
  "GMAX_RERANK_TOP",
  "GMAX_RERANK_BLEND",
  "GMAX_MAX_PER_FILE",
  "GMAX_DEF_BOOST",
  "GMAX_CONCENTRATION_THRESHOLD",
  "GMAX_ANCHOR_PENALTY",
  "GMAX_TEST_PENALTY",
  "GMAX_DOC_PENALTY",
  "GMAX_PAGERANK",
  "GMAX_PR_WEIGHT",
  "GMAX_SEED_FILE_W",
  "GMAX_SEED_SYMBOL_DEF_W",
  "GMAX_SEED_SYMBOL_REF_W",
  "GMAX_SEED_MAX_RANK",
  "GMAX_ANN",
  "GMAX_ANN_NPROBES",
  "GMAX_ANN_MAX_NPROBES",
];
const key = (r: VectorRecord) => r.id || `${r.path}:${r.chunk_index}`;

/** Request-local pointer trace. No content, vectors or additional database reads. */
export class SearchDiagnosticCollector {
  private ranks = new Map<SearchStage, Map<string, number>>();
  private cohort: VectorRecord[] = [];
  private total = 0;
  private fileLimited = new Set<string>();

  noteFileLimit(record: VectorRecord) {
    this.fileLimited.add(key(record));
  }

  private outcome(
    record: VectorRecord,
  ): SearchDiagnostics["trace"]["candidates"][number]["outcome"] {
    const id = key(record);
    if (this.ranks.get("final")?.has(id)) return "returned";
    if (!this.ranks.get("stage1")?.has(id)) return "stage1-cut";
    if (
      !this.ranks.get("pooled")?.has(id) &&
      !this.ranks.get("scored")?.has(id)
    )
      return "pooled-cut";
    if (!this.ranks.get("scored")?.has(id)) return "not-scored";
    if (!this.ranks.get("dedup")?.has(id)) return "deduplicated";
    if (this.fileLimited.has(id)) return "per-file-limit";
    // After the display window fills, remaining candidates are unexamined.
    return "display-limit";
  }

  capture(stage: SearchStage, records: VectorRecord[]) {
    this.ranks.set(stage, new Map(records.map((r, i) => [key(r), i + 1])));
    if (stage === "fusion") {
      this.total = records.length;
      this.cohort = records.slice(0, 200);
    }
  }

  finish(
    details: Pick<SearchDiagnostics, "settings" | "gate" | "fts">,
  ): SearchDiagnostics {
    return {
      schemaVersion: 1,
      ...details,
      rankingEnvironment: Object.fromEntries(
        rankingKeys.map((name) => [name, process.env[name] ?? null]),
      ),
      stages: Object.fromEntries(
        stages.map((s) => [s, this.ranks.get(s)?.size ?? 0]),
      ) as Record<SearchStage, number>,
      trace: {
        cohort: "post-seed-fusion-head",
        limit: 200,
        total: this.total,
        truncated: this.total > this.cohort.length,
        candidates: this.cohort.map((r) => ({
          id: key(r),
          path: r.path,
          hash: r.hash,
          startLine: r.start_line + 1,
          endLine: r.end_line + 1,
          parentSymbol: r.parent_symbol ?? "",
          outcome: this.outcome(r),
          ranks: Object.fromEntries(
            stages.map((s) => [s, this.ranks.get(s)?.get(key(r)) ?? 0]),
          ) as Record<SearchStage, number>,
        })),
      },
    };
  }
}
