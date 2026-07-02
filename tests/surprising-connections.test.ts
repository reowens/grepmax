import { afterEach, describe, expect, it, vi } from "vitest";
import { surprises } from "../src/commands/surprises";
import {
  analyzeSurprisingConnections,
  buildFindings,
  type ChunkRow,
  type SurprisePair,
  scorePair,
} from "../src/lib/analysis/surprising-connections";

const PREFIX = "/repo/";

function chunk(
  relPath: string,
  symbol: string,
  content = `function ${symbol}() {\n  return doWork();\n}`,
): ChunkRow {
  const lines = content.split("\n");
  return {
    id: `${relPath}:${symbol}`,
    path: `${PREFIX}${relPath}`,
    relPath,
    startLine: 10,
    endLine: 10 + lines.length - 1,
    role: "IMPLEMENTATION",
    content,
    vector: new Float32Array(3),
    definedSymbols: [symbol],
    referencedSymbols: [],
    typeReferencedSymbols: [],
  };
}

function pair(
  source: ChunkRow,
  target: ChunkRow,
  similarity: number,
): SurprisePair {
  return {
    source,
    target,
    similarity,
    distance: 1 / similarity - 1,
  };
}

function rawChunk(relPath: string, symbol: string) {
  return {
    id: `${relPath}:${symbol}`,
    path: `${PREFIX}${relPath}`,
    start_line: 10,
    end_line: 24,
    role: "IMPLEMENTATION",
    content:
      "function scopedThing() {\n" +
      "  const value = computeOneThingAndThenAnotherThing();\n" +
      "  return value + computeFollowupThing();\n" +
      "}\n",
    vector: [0.1, 0.2, 0.3],
    defined_symbols: [symbol],
    referenced_symbols: [],
    type_referenced_symbols: [],
  };
}

function fakeTable(
  rows: Record<string, unknown>[],
  neighborRows: Record<string, unknown>[] = [],
) {
  const wheres: string[] = [];
  const chain = (resultRows: Record<string, unknown>[]) => ({
    select() {
      return this;
    },
    where(where: string) {
      wheres.push(where);
      return this;
    },
    limit() {
      return this;
    },
    async toArray() {
      return resultRows;
    },
  });
  return {
    wheres,
    table: {
      query: () => chain(rows),
      vectorSearch: () => chain(neighborRows),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("surprising connection scoring", () => {
  it("applies scope filters to row scans and neighbor searches", async () => {
    const { table, wheres } = fakeTable([
      rawChunk("src/commands/a.ts", "scopedThing"),
    ]);

    await analyzeSurprisingConnections(table, "/repo", {
      sample: 1,
      neighbors: 1,
      in: "src/commands",
      exclude: "src/commands/generated",
    });

    expect(wheres).toHaveLength(2);
    for (const where of wheres) {
      expect(where).toContain("starts_with(path, '/repo/src/commands/')");
      expect(where).toContain(
        "NOT starts_with(path, '/repo/src/commands/generated/')",
      );
    }
  });

  it("drops vector neighbors without usable symbols", async () => {
    const weakNeighbor = {
      ...rawChunk("src/other.ts", "otherThing"),
      defined_symbols: [],
    };
    const { table } = fakeTable(
      [rawChunk("src/source.ts", "sourceThing")],
      [weakNeighbor],
    );

    const result = await analyzeSurprisingConnections(table, "/repo", {
      sample: 1,
      neighbors: 1,
    });

    expect(result.summary.filters.weakCode).toBe(1);
    expect(result.summary.acceptedPairs).toBe(0);
  });

  it("groups chunk pairs by file pair and keeps the strongest representative", () => {
    const a1 = chunk("src/a.ts", "sharedHelper");
    const b1 = chunk("src/b.ts", "sharedHelper");
    const a2 = chunk("src/a.ts", "formatThing");
    const b2 = chunk("src/b.ts", "renderThing");

    const findings = buildFindings([
      pair(a2, b2, 0.8),
      pair(a1, b1, 0.9),
      pair(chunk("src/c.ts", "other"), chunk("src/d.ts", "other"), 0.85),
    ]);

    const ab = findings.find(
      (finding) => finding.fileA === "src/a.ts" && finding.fileB === "src/b.ts",
    );
    expect(ab).toBeDefined();
    expect(ab!.pairCount).toBe(2);
    expect(ab!.representative.source.definedSymbols).toContain("sharedHelper");
    expect(ab!.reasons).toContain("same-symbol");
    expect(ab!.reasons).toContain("multi-pair");
  });

  it("scores command-to-library wrappers but marks the wrapper penalty", () => {
    const p = pair(
      chunk("src/commands/trace.ts", "walkCallers"),
      chunk("src/lib/llm/tools.ts", "walkCallers"),
      0.88,
    );

    const score = scorePair(p, 2);

    expect(score.reasons).toContain("command-wrapper");
    expect(score.reasons).toContain("same-symbol");
    expect(score.wrapperPenalty).toBeGreaterThan(0);
  });

  it("demotes constant/type-only chunks", () => {
    const p = pair(
      chunk("src/a.ts", "LOG_MODELS", "const LOG_MODELS = true;"),
      chunk("src/b.ts", "LOG_MODELS", "const LOG_MODELS = true;"),
      0.9,
    );

    const score = scorePair(p, 1);

    expect(score.reasons).toContain("type-constant");
    expect(score.typeConstantPenalty).toBeGreaterThan(0);
  });
});

describe("surprises command", () => {
  it("requires --experimental", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await surprises.parseAsync([], { from: "user" });

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("--experimental"));
    expect(process.exitCode).toBe(1);
  });
});
