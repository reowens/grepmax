import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import {
  formatCompactTable,
  toCompactHits,
  toTextResults,
} from "../src/lib/output/compact-results";
import { formatResult } from "../src/lib/output/formatter";
import type { ChunkType } from "../src/lib/store/types";
import { formatTextResults } from "../src/lib/utils/formatter";

function hit(file: string, over: Partial<ChunkType> = {}): ChunkType {
  return {
    type: "text",
    text: "The comms data model keeps one row per conversation.",
    score: 0.42,
    metadata: { path: `/repo/${file}`, hash: "" },
    generated_metadata: { start_line: 9, end_line: 12 },
    role: "DOCS",
    ...over,
  };
}

const archived = hit("docs/archive/comms-data-model.md", {
  docStatus: "archived",
  scoreBreakdown: {
    rerank: 0.5,
    fused: 0.1,
    boost: 0.3,
    archive: 0.5,
    normalized: 0.42,
  },
});
const current = hit("docs/comms.md", { docStatus: null });
// formatResult colours its output when stdout is a terminal.
const plain = stripVTControlCharacters;

describe("doc status in plain and compact output", () => {
  it("carries docStatus through toTextResults and tags plain lines", () => {
    const text = toTextResults([archived, current]);
    expect(text.map((r) => r.docStatus)).toEqual(["archived", null]);
    const out = formatTextResults(text, "comms model", "/repo", {
      isPlain: true,
    });
    expect(out).toContain("docs/archive/comms-data-model.md:10 [ARCHIVED]\n");
    expect(out).toContain("docs/comms.md:10\n");
  });

  it("tags the human text header", () => {
    const out = formatTextResults(toTextResults([archived]), "q", "/repo", {
      isPlain: false,
    });
    expect(out).toContain("[ARCHIVED]");
  });

  it("appends ARCH to the compact role cell without adding a column", () => {
    const hits = toCompactHits([archived, current]);
    expect(hits.map((h) => h.docStatus)).toEqual(["archived", null]);
    const tsv = formatCompactTable(hits, "/repo", "q", {
      isTTY: false,
      plain: true,
    }).split("\n");
    const columns = tsv[1].split("\t").length;
    expect(tsv[2].split("\t")).toHaveLength(columns);
    expect(tsv[2].split("\t")[3]).toBe("DOCS ARCH");
    expect(tsv[3].split("\t")[3]).toBe("DOCS");
  });
});

describe("doc status in formatResult", () => {
  it("tags the header and lists the archive factor in Scoring", () => {
    const out = plain(formatResult(archived, "/repo", { explain: true }));
    expect(out.split("\n")[0]).toContain(
      "docs/archive/comms-data-model.md:9 [ARCHIVED]",
    );
    expect(out).toContain("boost=0.30x  archive=0.50x  final=0.420");
  });

  it("leaves a current doc unlabelled", () => {
    const out = formatResult(current, "/repo", { explain: true });
    expect(out).not.toContain("ARCHIVED");
  });
});
