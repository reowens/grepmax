import { describe, expect, it } from "vitest";
import {
  err,
  filterMcpSearchResults,
  formatMcpPointerSearchResults,
  ok,
  toStringArray,
} from "../src/commands/mcp";
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
