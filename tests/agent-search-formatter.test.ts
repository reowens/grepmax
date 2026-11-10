import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { formatAgentSearchResults } from "../src/lib/output/agent-search-formatter";

function chunk(over: Record<string, unknown> = {}) {
  return {
    path: "/proj/src/lib/store/meta-cache.ts",
    start_line: 10,
    end_line: 16,
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
    expect(out).toContain("meta-cache.ts:15");
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

  it("uses source text rather than an unlocated summary", () => {
    const out = formatAgentSearchResults(
      [chunk({ summary: "LMDB-backed file metadata cache" })],
      "/proj",
      { query: "mtime size" },
    );
    expect(out).not.toContain("LMDB-backed file metadata cache");
    expect(out).toContain("meta-cache.ts:15");
    expect(out).toContain("entry.mtimeMs");
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

describe("agent pointer source locations", () => {
  it("ignores rich context outside a split chunk and numbers the chosen body line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-pointer-"));
    try {
      const file = path.join(root, "client.ts");
      const source = [
        "/** Remote control client. */",
        "export class Client {",
        "",
        "  /** Keep the connection alive. */",
        "  startKeepAlive() {",
        "    if (!this.socket || !this.socketConnected) return;",
        "  }",
        "}",
      ];
      fs.writeFileSync(file, source.join("\n"));
      const hit = chunk({
        path: file,
        start_line: 3,
        end_line: 6,
        content:
          "// client.ts\nFile: client.ts > Class: Client\n" +
          source.slice(3, 7).join("\n") +
          "\n/** Remote control client. */",
        defined_symbols: [],
      });
      const out = formatAgentSearchResults([hit], root, {
        query: "socket connected",
      });
      expect(out).toContain("client.ts:6");
      expect(out).toContain(
        "— if (!this.socket || !this.socketConnected) return;",
      );
      const contextMatch = formatAgentSearchResults([hit], root, {
        query: "remote control client",
      });
      expect(contextMatch).toContain("client.ts:5");
      expect(contextMatch).toContain("— startKeepAlive() {");
      expect(contextMatch).not.toContain("Remote control client");
      expect(formatAgentSearchResults([hit], root)).toContain("client.ts:5");
      const grouped = formatAgentSearchResults([hit, hit], root, {
        query: "socket",
      });
      expect(grouped.match(/ {2}:6\t/g)).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not invent a location for rich indexed text when the file is unavailable", () => {
    const out = formatAgentSearchResults(
      [
        chunk({
          content:
            "// missing.ts\nFile: missing.ts > Class: Client\nif (this.socket) return;\n/** Remote control client. */",
        }),
      ],
      "/proj",
      { query: "remote control" },
    );
    expect(out).toContain("meta-cache.ts:11");
    expect(out).not.toContain(" — ");
  });

  it.each([
    { startLine: 10, endLine: 16, start_line: undefined, end_line: undefined },
    {
      generated_metadata: { start_line: 10, end_line: 16 },
      start_line: undefined,
      end_line: undefined,
    },
  ])("preserves offsets for alternate line metadata: %j", (metadata) => {
    const out = formatAgentSearchResults([chunk(metadata)], "/proj", {
      query: "stats size",
    });
    expect(out).toContain("meta-cache.ts:15");
  });
});

describe("agent pointer doc status", () => {
  const breakdown = (archive: number) => ({
    rerank: 0.5,
    fused: 0.1,
    boost: 0.3,
    archive,
    normalized: 0.8,
  });

  it("tags an archived hit after its role and shows the applied factor", () => {
    const out = formatAgentSearchResults(
      [
        chunk({
          path: "/proj/docs/archive/meta-cache.md",
          role: "DOCS",
          docStatus: "archived",
          scoreBreakdown: breakdown(0.5),
        }),
      ],
      "/proj",
      { explain: true },
    );
    expect(out).toContain("MetaCache [DOCS] [ARCHIVED] — ");
    expect(out).toContain(
      "explain:rerank=0.500,fused=0.100,boost=0.30x,archive=0.50x,score=0.800",
    );
  });

  it("keeps the label and drops archive= when the factor was waived", () => {
    const out = formatAgentSearchResults(
      [
        chunk({
          path: "/proj/docs/archive/meta-cache.md",
          role: "DOCS",
          docStatus: "archived",
          scoreBreakdown: breakdown(1),
        }),
      ],
      "/proj",
      { explain: true },
    );
    expect(out).toContain("[ARCHIVED]");
    expect(out).not.toContain("archive=");
  });

  it("prints nothing extra for a current chunk", () => {
    const out = formatAgentSearchResults([chunk({ docStatus: null })], "/proj");
    expect(out).not.toContain("ARCHIVED");
  });
});
