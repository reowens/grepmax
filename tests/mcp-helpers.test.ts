import { describe, expect, it } from "vitest";
import {
  err,
  filterMcpSearchResults,
  formatMcpPointerSearchResults,
  formatMcpSurprisingConnections,
  isExplicitCrossProjectSearch,
  mcpLogQuery,
  ok,
  toStringArray,
} from "../src/commands/mcp";
import type { SurpriseAnalysisResult } from "../src/lib/analysis/surprising-connections";
import type { ChunkType } from "../src/lib/store/types";

describe("toStringArray", () => {
  it("returns strings from a string array", () => {
    expect(toStringArray(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("filters out non-string values", () => {
    expect(toStringArray(["a", 1, null, "b", undefined])).toEqual(["a", "b"]);
  });

  it("returns empty array for non-array input", () => {
    expect(toStringArray("not an array")).toEqual([]);
    expect(toStringArray(123)).toEqual([]);
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray(undefined)).toEqual([]);
  });

  it("handles objects with toArray method", () => {
    const obj = { toArray: () => ["x", "y"] };
    expect(toStringArray(obj)).toEqual(["x", "y"]);
  });

  it("handles toArray returning non-array", () => {
    const obj = { toArray: () => "not array" };
    expect(toStringArray(obj)).toEqual([]);
  });

  it("handles toArray that throws", () => {
    const obj = {
      toArray: () => {
        throw new Error("boom");
      },
    };
    expect(toStringArray(obj)).toEqual([]);
  });

  it("returns empty array for empty array input", () => {
    expect(toStringArray([])).toEqual([]);
  });
});

describe("ok", () => {
  it("wraps text in MCP content format", () => {
    const result = ok("success");
    expect(result).toEqual({
      content: [{ type: "text", text: "success" }],
    });
    expect(result.isError).toBeUndefined();
  });
});

describe("err", () => {
  it("wraps text in MCP error format", () => {
    const result = err("failure");
    expect(result).toEqual({
      content: [{ type: "text", text: "failure" }],
      isError: true,
    });
  });
});

describe("isExplicitCrossProjectSearch", () => {
  it("treats scope all and project filters as explicit cross-project search", () => {
    expect(isExplicitCrossProjectSearch({ scope: "all" })).toBe(true);
    expect(isExplicitCrossProjectSearch({ projects: "platform" })).toBe(true);
    expect(isExplicitCrossProjectSearch({ exclude_projects: "qsys" })).toBe(
      true,
    );
    expect(isExplicitCrossProjectSearch({}, true)).toBe(true);
  });

  it("does not widen project search for empty project filters", () => {
    expect(isExplicitCrossProjectSearch({})).toBe(false);
    expect(isExplicitCrossProjectSearch({ projects: "  " })).toBe(false);
    expect(isExplicitCrossProjectSearch({ exclude_projects: "" })).toBe(false);
    expect(isExplicitCrossProjectSearch({ scope: "project" })).toBe(false);
  });
});

function chunk(
  file: string,
  line: number,
  symbol: string,
  score: number,
): ChunkType {
  return {
    type: "text",
    text: `export function ${symbol}() {}`,
    score,
    metadata: { path: `/tmp/project/${file}`, hash: "" },
    generated_metadata: { start_line: line, end_line: line, type: "function" },
    defined_symbols: [symbol],
    role: "DEFINITION",
  };
}

describe("filterMcpSearchResults", () => {
  it("applies score, max-per-file, and name filters", () => {
    const data = [
      chunk("src/a.ts", 0, "alpha", 0.9),
      chunk("src/a.ts", 4, "beta", 0.8),
      chunk("src/b.ts", 2, "alphaHelper", 0.4),
      chunk("src/c.ts", 1, "gamma", 0.95),
    ];

    const filtered = filterMcpSearchResults(data, {
      minScore: 0.5,
      maxPerFile: 1,
      namePattern: "alpha|beta",
    });

    expect(filtered.map((r) => r.defined_symbols?.[0])).toEqual(["alpha"]);
  });

  it("ignores invalid name regexes", () => {
    const data = [chunk("src/a.ts", 0, "alpha", 0.9)];
    expect(
      filterMcpSearchResults(data, { namePattern: "[" }).map(
        (r) => r.defined_symbols?.[0],
      ),
    ).toEqual(["alpha"]);
  });
});

describe("formatMcpPointerSearchResults", () => {
  it("uses the shared agent pointer format and groups same-file hits", () => {
    const output = formatMcpPointerSearchResults(
      [
        chunk("src/a.ts", 0, "alpha", 0.9),
        chunk("src/a.ts", 4, "beta", 0.8),
        chunk("src/b.ts", 2, "gamma", 0.7),
      ],
      "/tmp/project",
    );

    expect(output).toContain("src/a.ts (2 hits):");
    expect(output).toContain("  :1\ts=0.900 alpha [DEFI]");
    expect(output).toContain("  :5\ts=0.800 beta [DEFI]");
    expect(output).toContain("src/b.ts:3\ts=0.700 gamma [DEFI]");
  });

  it("can prepend imports once per file", () => {
    const output = formatMcpPointerSearchResults(
      [chunk("src/a.ts", 0, "alpha", 0.9)],
      "/tmp/project",
      {
        includeImports: true,
        getImportsForFile: () => "import { x } from './x';",
      },
    );

    expect(output).toContain("[imports src/a.ts] import { x } from './x';");
    expect(output).toContain("src/a.ts:1");
  });
});

describe("formatMcpSurprisingConnections", () => {
  it("renders summary and grouped file-pair rows as TSV", () => {
    const result: SurpriseAnalysisResult = {
      summary: {
        projectRoot: "/tmp/project",
        rows: 10,
        codeRows: 4,
        sampledAnchors: 3,
        graphFileEdges: 2,
        options: {
          sample: 3,
          neighbors: 2,
          dirDepth: 3,
          minSimilarity: 0,
          maxRows: 50_000,
          includeTests: false,
          includeEval: false,
        },
        filters: {
          rawNeighbors: 3,
          sameChunk: 0,
          sameFile: 0,
          nonCode: 0,
          weakCode: 0,
          tests: 0,
          evalHarness: 0,
          sameDirBucket: 0,
          graphEdge: 0,
          belowThreshold: 0,
        },
        acceptedPairs: 1,
        acceptedFilePairs: 1,
        similarity: { min: 0.8, p50: 0.8, p90: 0.8, max: 0.8, mean: 0.8 },
        distance: { min: 0.2, p50: 0.2, p90: 0.2, max: 0.2, mean: 0.2 },
        actionabilityScore: {
          min: 0.9,
          p50: 0.9,
          p90: 0.9,
          max: 0.9,
          mean: 0.9,
        },
      },
      pairs: [],
      findings: [
        {
          fileA: "src/a.ts",
          fileB: "src/b.ts",
          pairCount: 1,
          maxSimilarity: 0.8,
          medianSimilarity: 0.8,
          score: 0.9,
          reasons: ["same-symbol"],
          topSimilarities: [0.8],
          representative: {
            similarity: 0.8,
            distance: 0.2,
            source: {
              id: "a",
              path: "/tmp/project/src/a.ts",
              relPath: "src/a.ts",
              startLine: 0,
              endLine: 5,
              role: "IMPLEMENTATION",
              content: "function sharedThing() { return 1; }",
              vector: [0.1],
              definedSymbols: ["sharedThing"],
              referencedSymbols: [],
              typeReferencedSymbols: [],
            },
            target: {
              id: "b",
              path: "/tmp/project/src/b.ts",
              relPath: "src/b.ts",
              startLine: 10,
              endLine: 15,
              role: "IMPLEMENTATION",
              content: "function sharedThing() { return 2; }",
              vector: [0.2],
              definedSymbols: ["sharedThing"],
              referencedSymbols: [],
              typeReferencedSymbols: [],
            },
            scoreParts: {
              base: 0.8,
              sameSymbolBoost: 0.08,
              symbolShapeBoost: 0,
              implementationBoost: 0,
              supportBoost: 0,
              tinyHelperPenalty: 0,
              typeConstantPenalty: 0,
              wrapperPenalty: 0,
              genericSymbolPenalty: 0,
              score: 0.9,
              reasons: ["same-symbol"],
            },
          },
        },
      ],
    };

    const output = formatMcpSurprisingConnections(result, 5);

    expect(output).toContain(
      "summary\tsampled=3\tcode=4\tpairs=1\tfile_pairs=1\tscore_p90=0.9",
    );
    expect(output).toContain(
      "surprise\t0.900\t0.800\t1\tsrc/a.ts\tsrc/b.ts\tsrc/a.ts:1 sharedThing\tsrc/b.ts:11 sharedThing\tsame-symbol",
    );
    expect(output).toContain("buckets=src<->src");
    expect(output).toContain('next=gmax skeleton "src/a.ts"');
  });
});

describe("mcpLogQuery", () => {
  it("uses regular query-like fields when present", () => {
    expect(mcpLogQuery("semantic_search", { query: "auth flow" })).toBe(
      "auth flow",
    );
    expect(mcpLogQuery("trace_calls", { symbol: "handleAuth" })).toBe(
      "handleAuth",
    );
    expect(mcpLogQuery("find_similar", { target: "VectorDB" })).toBe(
      "VectorDB",
    );
  });

  it("records surprising_connections scope instead of an empty query", () => {
    expect(
      mcpLogQuery("surprising_connections", {
        root: "/repo",
        in: "src/lib",
        exclude: "src/lib/generated",
      }),
    ).toBe(
      "surprising_connections root=/repo in=src/lib exclude=src/lib/generated",
    );
  });
});
