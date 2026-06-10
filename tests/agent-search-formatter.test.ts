import { describe, expect, it } from "vitest";
import { formatAgentSearchResults } from "../src/lib/output/agent-search-formatter";

function chunk(over: Record<string, unknown> = {}) {
  return {
    path: "/proj/src/lib/store/meta-cache.ts",
    start_line: 10,
    defined_symbols: ["MetaCache"],
    role: "IMPLEMENTATION",
    score: 0.9,
    content: [
      "export class MetaCache {",
      "  private db: Database;",
      "  // skip files whose mtime and size match the cached entry",
      "  isFresh(entry: MetaEntry, stats: Stats): boolean {",
      "    return entry.mtimeMs === stats.mtimeMs && entry.size === stats.size;",
      "  }",
      "}",
    ].join("\n"),
    ...over,
  } as any;
}

describe("formatAgentSearchResults hint selection", () => {
  it("falls back to the first signature line without a query", () => {
    const out = formatAgentSearchResults([chunk()], "/proj");
    expect(out).toContain("— export class MetaCache {");
  });

  it("prefers the line matching the query terms over the first line", () => {
    const out = formatAgentSearchResults([chunk()], "/proj", {
      query: "mtime size freshness check",
    });
    expect(out).toContain("entry.mtimeMs === stats.mtimeMs");
  });

  it("prefers code over a comment when both match equally", () => {
    const out = formatAgentSearchResults([chunk()], "/proj", {
      query: "cached entry mtime",
    });
    // The comment matches 3 terms, the return line only 1 — comment wins on
    // count. But for a tie, code must win:
    const tied = formatAgentSearchResults([chunk()], "/proj", {
      query: "stats size",
    });
    expect(tied).toContain("entry.mtimeMs === stats.mtimeMs");
    expect(out).toContain("// skip files whose mtime and size match");
  });

  it("keeps the summary when one exists", () => {
    const out = formatAgentSearchResults(
      [chunk({ summary: "LMDB-backed file metadata cache" })],
      "/proj",
      { query: "mtime size" },
    );
    expect(out).toContain("LMDB-backed file metadata cache");
    expect(out).not.toContain("entry.mtimeMs");
  });

  it("ignores import lines even when they match", () => {
    const c = chunk({
      content: [
        'import { isFileCached } from "../utils/cache-check";',
        "export function runCatchup() {",
        "  if (isFileCached(entry, stats)) return;",
        "}",
      ].join("\n"),
      defined_symbols: ["runCatchup"],
    });
    const out = formatAgentSearchResults([c], "/proj", {
      query: "isFileCached",
    });
    expect(out).toContain("if (isFileCached(entry, stats)) return;");
  });
});
