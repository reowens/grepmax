/** Indexed chunk spans are zero-based internally; only public serializers add one. */
export interface TraceChunkSpan {
  file: string;
  startLine: number;
  endLine: number | null;
}

export type TraceReferenceColumn =
  | "referenced_symbols"
  | "member_referenced_symbols"
  | "type_referenced_symbols";

export type TraceSelectionBasis =
  | "first_definition_match"
  | "same_file"
  | "same_language_family"
  | "first_candidate"
  | "caller_chunk_attribution"
  | "receiver_unresolved"
  | "no_candidate"
  | "unknown";

export interface TraceEdgeEvidence {
  referenceSpelling: string;
  referenceColumns: TraceReferenceColumn[] | null;
  sourceChunk: TraceChunkSpan | null;
  targetCandidate: TraceChunkSpan | null;
  selectionBasis: TraceSelectionBasis;
  callsite: null;
  bindingResolved: false;
}

export interface TraceCenterSelection {
  referenceSpelling: string;
  targetCandidate: TraceChunkSpan | null;
  selectionBasis: "first_definition_match" | "no_candidate" | "unknown";
}

export const TRACE_COVERAGE_STAGES = [
  "center_candidates",
  "caller_rows",
  "callee_spellings",
  "callee_candidates",
  "importer_files",
  "caller_expansion",
  "display_callees",
  "display_importers",
  "display_callers",
] as const;

export type TraceCoverageStage = (typeof TRACE_COVERAGE_STAGES)[number];
export type TraceCoverageStatus = "complete" | "partial" | "unknown";

export interface TraceCoverageSummary {
  status: TraceCoverageStatus;
  operations: number;
  observed: number;
  retained: number;
  filteredByPolicy: number;
  /** Importer stage only: raw duplicate stream rows, separate from file counts. */
  duplicateRows?: number;
  limit: number | null;
  limitedOperations: number;
  reasons: string[];
  omitted: { exact: number | null; lowerBound: number };
}

/** Counts use rows for candidate/caller queries, spellings for callees, and
 * unique files for importers. Stages overlap and must never be totaled. */
export interface TraceCoverage {
  version: 1;
  requestedDepth: number | null;
  effectiveDepth: number;
  scope: "indexed";
  depthSemantics: "requested_boundary";
  stages: Record<TraceCoverageStage, TraceCoverageSummary>;
}

export interface TraceMetadata {
  evidenceVersion: 1;
  centerSelection: TraceCenterSelection;
  coverage: TraceCoverage;
}

export interface TraceMetadataInput {
  evidenceVersion?: 1 | null;
  centerSelection?: TraceCenterSelection | null;
  coverage?: TraceCoverage | null;
}

/** Request-local only: never stored on the shared GraphBuilder instance. */
export interface TraceCollector {
  coverage: TraceCoverage;
  centerSelection: TraceCenterSelection | null;
}

export interface TraceCoverageObservation {
  observed: number;
  retained: number;
  filteredByPolicy?: number;
  duplicateRows?: number;
  limit?: number | null;
  limited?: boolean;
  status?: TraceCoverageStatus;
  reasons?: string[];
  omitted?: { exact: number | null; lowerBound: number };
}

function emptySummary(unknown = false): TraceCoverageSummary {
  return {
    status: unknown ? "unknown" : "complete",
    operations: 0,
    observed: 0,
    retained: 0,
    filteredByPolicy: 0,
    limit: null,
    limitedOperations: 0,
    reasons: unknown ? ["legacy_metadata_unavailable"] : [],
    omitted: { exact: unknown ? null : 0, lowerBound: 0 },
  };
}

export function createTraceCollector(
  requestedDepth: number | null,
  effectiveDepth: number,
): TraceCollector {
  return {
    centerSelection: null,
    coverage: {
      version: 1,
      requestedDepth,
      effectiveDepth,
      scope: "indexed",
      depthSemantics: "requested_boundary",
      stages: Object.fromEntries(
        TRACE_COVERAGE_STAGES.map((stage) => [stage, emptySummary()]),
      ) as Record<TraceCoverageStage, TraceCoverageSummary>,
    },
  };
}

/** Pure aggregation: query observations are counts, not unique identities. */
export function addTraceCoverageObservation(
  coverage: TraceCoverage,
  stage: TraceCoverageStage,
  observation: TraceCoverageObservation,
): TraceCoverage {
  const prior = coverage.stages[stage];
  const omitted = observation.omitted ?? { exact: 0, lowerBound: 0 };
  const status =
    observation.status ??
    (omitted.exact === null
      ? "unknown"
      : omitted.exact > 0
        ? "partial"
        : "complete");
  const combinedStatus =
    prior.status === "unknown" || status === "unknown"
      ? "unknown"
      : prior.status === "partial" || status === "partial"
        ? "partial"
        : "complete";
  return {
    ...coverage,
    stages: {
      ...coverage.stages,
      [stage]: {
        status: combinedStatus,
        operations: prior.operations + 1,
        observed: prior.observed + observation.observed,
        retained: prior.retained + observation.retained,
        filteredByPolicy:
          prior.filteredByPolicy + (observation.filteredByPolicy ?? 0),
        ...(prior.duplicateRows !== undefined ||
        observation.duplicateRows !== undefined
          ? {
              duplicateRows:
                (prior.duplicateRows ?? 0) + (observation.duplicateRows ?? 0),
            }
          : {}),
        limit:
          prior.operations === 0
            ? (observation.limit ?? null)
            : prior.limit === (observation.limit ?? null)
              ? prior.limit
              : null,
        limitedOperations:
          prior.limitedOperations + (observation.limited ? 1 : 0),
        reasons: Array.from(
          new Set([...prior.reasons, ...(observation.reasons ?? [])]),
        ),
        omitted: {
          exact:
            prior.omitted.exact === null || omitted.exact === null
              ? null
              : prior.omitted.exact + omitted.exact,
          lowerBound: prior.omitted.lowerBound + omitted.lowerBound,
        },
      },
    },
  };
}

export function recordTraceCoverage(
  collector: TraceCollector | undefined,
  stage: TraceCoverageStage,
  observation: TraceCoverageObservation,
): void {
  if (collector) {
    collector.coverage = addTraceCoverageObservation(
      collector.coverage,
      stage,
      observation,
    );
  }
}

/** Absent producer metadata from older daemons never implies completeness. */
export function normalizeTraceMetadata(
  metadata: TraceMetadataInput | null | undefined,
  effectiveDepth: number,
  requestedDepth: number | null = null,
): TraceMetadata {
  const fallback = createTraceCollector(
    requestedDepth,
    effectiveDepth,
  ).coverage;
  const stages = Object.fromEntries(
    TRACE_COVERAGE_STAGES.map((stage) => [
      stage,
      metadata?.coverage?.stages?.[stage] ?? emptySummary(true),
    ]),
  ) as Record<TraceCoverageStage, TraceCoverageSummary>;
  return {
    evidenceVersion: 1,
    centerSelection: metadata?.centerSelection ?? {
      referenceSpelling: "",
      targetCandidate: null,
      selectionBasis: "unknown",
    },
    coverage: { ...(metadata?.coverage ?? fallback), stages },
  };
}

export function withTraceDisplayCoverage(
  coverage: TraceCoverage,
  stage: "display_callees" | "display_importers" | "display_callers",
  observed: number,
  retained: number,
  limit: number | null = null,
  filteredByPolicy = 0,
): TraceCoverage {
  const omitted = Math.max(0, observed - retained - filteredByPolicy);
  const base =
    coverage.stages[stage].operations === 0
      ? { ...coverage, stages: { ...coverage.stages, [stage]: emptySummary() } }
      : coverage;
  return addTraceCoverageObservation(base, stage, {
    observed,
    retained,
    filteredByPolicy,
    limit,
    limited: omitted > 0,
    reasons: omitted > 0 ? ["display_limit"] : [],
    omitted: { exact: omitted, lowerBound: omitted },
  });
}

function publicSpan(span: TraceChunkSpan | null): TraceChunkSpan | null {
  return span
    ? {
        ...span,
        startLine: span.startLine + 1,
        endLine: span.endLine === null ? null : span.endLine + 1,
      }
    : null;
}

/** Call only at the public serialization boundary, never on public data. */
export function toPublicTraceEdgeEvidence(
  evidence: TraceEdgeEvidence,
): TraceEdgeEvidence {
  return {
    ...evidence,
    sourceChunk: publicSpan(evidence.sourceChunk),
    targetCandidate: publicSpan(evidence.targetCandidate),
  };
}

export function toPublicTraceCenterSelection(
  selection: TraceCenterSelection,
): TraceCenterSelection {
  return {
    ...selection,
    targetCandidate: publicSpan(selection.targetCandidate),
  };
}

export function traceEvidenceNote(coverage: TraceCoverage): string {
  const details: string[] = [];
  let legacyUnknown = false;
  for (const stage of TRACE_COVERAGE_STAGES) {
    const summary = coverage.stages[stage];
    if (summary.reasons.includes("legacy_metadata_unavailable")) {
      legacyUnknown = true;
      continue;
    }
    if (
      summary.status === "complete" &&
      summary.filteredByPolicy === 0 &&
      !summary.duplicateRows
    )
      continue;
    const omissions =
      summary.omitted.exact === null
        ? `omitted unknown (at least ${summary.omitted.lowerBound})`
        : `omitted ${summary.omitted.exact}`;
    const reasons = summary.reasons.includes("first_match_exhaustion_unknown")
      ? "first-match candidate enumeration unprobed"
      : summary.reasons.join(", ");
    details.push(
      `${stage}: ${summary.status}, observed ${summary.observed}, retained ${summary.retained}${summary.limit === null ? "" : `, limit ${summary.limit}`}, ${omissions}${summary.filteredByPolicy > 0 ? `, policy-filtered ${summary.filteredByPolicy}` : ""}${summary.duplicateRows ? `, duplicate rows ${summary.duplicateRows}` : ""}${reasons ? ` (${reasons})` : ""}`,
    );
  }
  if (legacyUnknown) details.unshift("legacy producer coverage unknown");
  return `Indexed references and candidate chunks; importers are text-match candidates; legacy kinds/confidence do not prove calls or target bindings. Coverage within indexed scope and depth ${coverage.effectiveDepth}: ${details.join("; ") || "complete for observed operations"}.`;
}

export function traceEvidenceSummary(coverage: TraceCoverage): string {
  return `# evidence ${traceEvidenceNote(coverage)}`;
}
