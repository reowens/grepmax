import { describe, expect, it } from "vitest";
import {
  addTraceCoverageObservation,
  createTraceCollector,
  normalizeTraceMetadata,
  TRACE_COVERAGE_STAGES,
  type TraceEdgeEvidence,
  toPublicTraceCenterSelection,
  toPublicTraceEdgeEvidence,
  withTraceDisplayCoverage,
} from "../src/lib/graph/trace-evidence";
import { traceResult } from "../src/lib/output/mcp-results";

const evidence: TraceEdgeEvidence = {
  referenceSpelling: "save",
  referenceColumns: [
    "referenced_symbols",
    "member_referenced_symbols",
    "type_referenced_symbols",
  ],
  sourceChunk: { file: "/caller.ts", startLine: 0, endLine: null },
  targetCandidate: { file: "/target.ts", startLine: 9, endLine: 12 },
  selectionBasis: "caller_chunk_attribution",
  callsite: null,
  bindingResolved: false,
};

describe("trace evidence aggregation and public boundary", () => {
  it("aggregates bounded observations without converting policy filtering into omissions", () => {
    const original = createTraceCollector(8, 5).coverage;
    const first = addTraceCoverageObservation(original, "caller_rows", {
      observed: 99,
      retained: 97,
      filteredByPolicy: 2,
      limit: 100,
    });
    const next = addTraceCoverageObservation(first, "caller_rows", {
      observed: 100,
      retained: 100,
      limit: 100,
      limited: true,
      reasons: ["query_limit"],
      omitted: { exact: null, lowerBound: 0 },
    });
    expect(original.stages.caller_rows.operations).toBe(0);
    expect(next.stages.caller_rows).toMatchObject({
      status: "unknown",
      operations: 2,
      observed: 199,
      retained: 197,
      filteredByPolicy: 2,
      limit: 100,
      limitedOperations: 1,
      omitted: { exact: null, lowerBound: 0 },
    });
    expect(next.requestedDepth).toBe(8);
    expect(next.effectiveDepth).toBe(5);
    expect(Object.keys(next.stages)).toEqual([...TRACE_COVERAGE_STAGES]);
    expect(next).not.toHaveProperty("omittedTotal");
  });

  it("adds exact and lower-bound omissions only within their own stage", () => {
    let coverage = createTraceCollector(1, 1).coverage;
    coverage = addTraceCoverageObservation(coverage, "callee_spellings", {
      observed: 17,
      retained: 15,
      omitted: { exact: 2, lowerBound: 2 },
    });
    coverage = addTraceCoverageObservation(coverage, "callee_spellings", {
      observed: 18,
      retained: 15,
      omitted: { exact: 3, lowerBound: 3 },
    });
    coverage = addTraceCoverageObservation(coverage, "caller_rows", {
      observed: 100,
      retained: 100,
      omitted: { exact: null, lowerBound: 0 },
    });
    expect(coverage.stages.callee_spellings.omitted).toEqual({
      exact: 5,
      lowerBound: 5,
    });
    expect(coverage.stages.caller_rows.omitted).toEqual({
      exact: null,
      lowerBound: 0,
    });
    expect(coverage.stages.callee_candidates).toMatchObject({
      operations: 0,
      observed: 0,
      retained: 0,
    });
    expect(coverage).not.toHaveProperty("omitted");
  });

  it("keeps independently unknown stages while exact display omissions are partial", () => {
    const legacy = normalizeTraceMetadata(undefined, 2);
    for (const summary of Object.values(legacy.coverage.stages)) {
      expect(summary).toMatchObject({
        status: "unknown",
        omitted: { exact: null, lowerBound: 0 },
      });
    }
    expect(legacy.coverage.requestedDepth).toBeNull();
    const display = withTraceDisplayCoverage(
      legacy.coverage,
      "display_importers",
      13,
      10,
      10,
      1,
    );
    expect(display.stages.display_importers).toMatchObject({
      status: "partial",
      filteredByPolicy: 1,
      omitted: { exact: 2, lowerBound: 2 },
    });
    expect(display.stages.importer_files.status).toBe("unknown");
    expect(legacy.coverage.stages.display_importers.status).toBe("unknown");
  });

  it("converts spans once at serialization and retains null ends and mixed columns", () => {
    const publicEvidence = toPublicTraceEdgeEvidence(evidence);
    expect(publicEvidence).toEqual({
      ...evidence,
      sourceChunk: { file: "/caller.ts", startLine: 1, endLine: null },
      targetCandidate: { file: "/target.ts", startLine: 10, endLine: 13 },
    });
    expect(evidence.sourceChunk?.startLine).toBe(0);
    const centerSelection = {
      referenceSpelling: "save",
      targetCandidate: evidence.targetCandidate,
      selectionBasis: "first_definition_match" as const,
    };
    expect(
      toPublicTraceCenterSelection(centerSelection).targetCandidate?.startLine,
    ).toBe(10);
    const node = {
      symbol: "save",
      file: "/target.ts",
      line: 9,
      role: "function",
      calls: [],
      calledBy: [],
    };
    const graph = {
      center: node,
      callerTree: [
        {
          node: { ...node, file: "/caller.ts", line: 0, evidence },
          callers: [],
        },
      ],
      callees: [],
      importers: [],
      evidenceVersion: 1 as const,
      centerSelection,
      coverage: createTraceCollector(1, 1).coverage,
    };
    const result = traceResult("save", "/", graph);
    expect(result.center?.location?.line).toBe(10);
    expect(result.callers[0].node.evidence).toEqual(publicEvidence);
    expect(result.centerSelection.targetCandidate?.startLine).toBe(10);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(evidence.callsite).toBeNull();
    expect(evidence.bindingResolved).toBe(false);
  });
});
