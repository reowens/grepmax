import { describe, expect, it } from "vitest";
import {
  searchResultEndLine,
  searchResultPath,
  searchResultStartLine,
} from "../src/commands/mcp";

// Regression: searcher.search() returns *mapped* ChunkType objects — the
// absolute path lives in `metadata.path` and line numbers in
// `generated_metadata`, NOT at the top level. build_context read `r.path`
// directly, so `rel(r.path)` got `rel(undefined)` and threw
// "Cannot read properties of undefined (reading 'startsWith')". diff_changes
// (query mode) had the same mismatch silently (filter never matched).
describe("search-result shape extraction (mapped ChunkType)", () => {
  const mapped = {
    type: "code",
    role: "ORCHESTRATION",
    metadata: { path: "/abs/src/lib/store/vector-db.ts" },
    generated_metadata: { start_line: 48, end_line: 96 },
    defined_symbols: ["VectorDB"],
  };

  it("reads the path from metadata.path when top-level path is absent", () => {
    expect(searchResultPath(mapped)).toBe("/abs/src/lib/store/vector-db.ts");
  });

  it("reads start/end lines from generated_metadata", () => {
    expect(searchResultStartLine(mapped)).toBe(48);
    expect(searchResultEndLine(mapped)).toBe(96);
  });

  it("still honors the raw top-level row shape (table.query results)", () => {
    const raw = { path: "/abs/x.ts", start_line: 3, end_line: 7 };
    expect(searchResultPath(raw)).toBe("/abs/x.ts");
    expect(searchResultStartLine(raw)).toBe(3);
    expect(searchResultEndLine(raw)).toBe(7);
  });

  it("never throws on a result with no path (the original crash)", () => {
    expect(searchResultPath({})).toBe("");
    expect(searchResultPath({ metadata: {} })).toBe("");
    // The actual crash site: rel(searchResultPath(r)) must get a string.
    expect(typeof searchResultPath({ generated_metadata: {} })).toBe("string");
  });

  it("does not skip a legitimate line 0 (nullish, not ||)", () => {
    expect(
      searchResultStartLine({ generated_metadata: { start_line: 0 } }),
    ).toBe(0);
    expect(searchResultStartLine({ start_line: 0 })).toBe(0);
  });

  it("falls back end -> start when end is missing", () => {
    expect(
      searchResultEndLine({ generated_metadata: { start_line: 12 } }, 12),
    ).toBe(12);
    expect(searchResultEndLine({}, 5)).toBe(5);
  });
});
