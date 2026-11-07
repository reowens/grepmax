import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { formatChunkText, TreeSitterChunker } from "../src/lib/index/chunker";
import { embeddingReuseKey } from "../src/lib/index/embedding-reuse";

// Deterministic word salad so fixtures read like prose without a fixture file.
function words(seed: number, count: number): string {
  const vocab = [
    "index", "chunk", "embed", "store", "query", "watch", "batch", "vector",
    "reuse", "edit", "file", "line", "worker", "search", "result", "plan",
    "the", "a", "of", "to", "and", "when", "every", "after", "before", "only",
  ];
  let x = seed * 2654435761;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out.push(vocab[x % vocab.length]);
  }
  return out.join(" ");
}

function markdownDoc(sections: number): string[] {
  const lines = ["---", "title: Example", "status: active", "---", "", "# Example plan", ""];
  for (let s = 0; s < sections; s++) {
    lines.push(`## Section ${s}`, "");
    const paragraphs = 1 + (s % 4);
    for (let p = 0; p < paragraphs; p++) {
      lines.push(words(s * 31 + p, 40 + ((s + p) % 5) * 25), "");
    }
    if (s % 3 === 0) {
      for (let b = 0; b < 6; b++) lines.push(`- ${words(s * 97 + b, 12)}`);
      lines.push("");
    }
  }
  return lines;
}

function plainText(paragraphs: number): string[] {
  const lines: string[] = [];
  for (let p = 0; p < paragraphs; p++) {
    for (let l = 0; l < 2 + (p % 4); l++) lines.push(words(p * 13 + l, 14));
    lines.push("");
  }
  return lines;
}

function tsFile(): string[] {
  const lines = ['import { join } from "node:path";', "", "export function build(root: string) {"];
  for (let s = 0; s < 70; s++) {
    lines.push(`  const step${s} = join(root, "part-${s}");`);
    lines.push(`  if (step${s}.length > ${s}) {`);
    lines.push(`    record(step${s}, ${s});`);
    lines.push("  }");
    if (s % 3 === 2) lines.push("");
  }
  lines.push("  return root;", "}", "");
  for (let f = 0; f < 4; f++) {
    lines.push(`export function helper${f}(value: number) {`, `  return value * ${f + 2};`, "}", "");
  }
  return lines;
}

async function keysOf(filePath: string, lines: string[]) {
  const chunker = new TreeSitterChunker();
  const { chunks, metadata } = await chunker.chunk(filePath, lines.join("\n"));
  const keys = chunks.map((chunk) =>
    embeddingReuseKey(
      formatChunkText({ ...chunk, context: chunk.context ?? [], imports: metadata.imports }, filePath)
        .content,
    ),
  );
  return { chunks, keys };
}

async function changedAfter(filePath: string, before: string[], after: string[]) {
  const a = await keysOf(filePath, before);
  const b = await keysOf(filePath, after);
  const stored = new Set(a.keys);
  return {
    total: b.keys.length,
    changed: b.keys.filter((key) => !stored.has(key)).length,
    chunks: b.chunks,
  };
}

const fixtures: Array<[string, string, () => string[], number]> = [
  ["markdown", "docs/example.md", () => markdownDoc(45), 4],
  ["TypeScript", "src/build.ts", tsFile, 5],
  ["no-grammar text", "notes/example.txt", () => plainText(90), 2],
];

describe("content-defined chunk boundaries", () => {
  for (const [label, filePath, make, at] of fixtures) {
    describe(label, () => {
      it("is long enough to need several chunks", async () => {
        const { chunks } = await keysOf(filePath, make());
        expect(chunks.length).toBeGreaterThan(8);
      });

      it("an insertion near the top changes at most 2 chunks", async () => {
        const before = make();
        const after = [...before];
        after.splice(at, 0, ...(label === "TypeScript"
          ? ["  // inserted note", "  // second inserted note", "  // third inserted note"]
          : ["inserted: one", "inserted: two", "inserted: three"]));
        const { total, changed } = await changedAfter(filePath, before, after);
        expect(total).toBeGreaterThan(8);
        expect(changed).toBeLessThanOrEqual(2);
      });

      it("a deletion near the top changes at most 2 chunks", async () => {
        const before = make();
        const after = [...before];
        // TypeScript drops a whole statement so the file still parses.
        if (label === "TypeScript") after.splice(3, 4);
        else after.splice(at + 1, 3);
        const { changed } = await changedAfter(filePath, before, after);
        expect(changed).toBeLessThanOrEqual(2);
      });

      it("an append changes at most 2 chunks", async () => {
        const before = make();
        const after = [...before, ...plainText(3)];
        const { changed } = await changedAfter(filePath, before, after);
        expect(changed).toBeLessThanOrEqual(2);
      });

      it("keeps every chunk within the size limits", async () => {
        const { chunks } = await keysOf(filePath, make());
        for (const chunk of chunks) {
          expect(chunk.content.length).toBeLessThanOrEqual(CONFIG.MAX_CHUNK_CHARS);
          expect(chunk.content.split("\n").length).toBeLessThanOrEqual(CONFIG.MAX_CHUNK_LINES);
        }
      });
    });
  }

  it("cuts a dense run with no blank lines at stable points", async () => {
    const before = Array.from({ length: 600 }, (_, i) => `entry ${i} ${words(i, 6)}`);
    const after = [...before];
    after.splice(2, 0, "entry inserted");
    const { total, changed } = await changedAfter("logs/run.log", before, after);
    expect(total).toBeGreaterThan(8);
    expect(changed).toBeLessThanOrEqual(2);
  });

  it("prefers a markdown heading as a cut point", async () => {
    const { chunks } = await keysOf("docs/example.md", markdownDoc(45));
    const headingStarts = chunks.filter((chunk) => chunk.content.startsWith("## ")).length;
    expect(headingStarts / chunks.length).toBeGreaterThan(0.5);
  });

  it("covers a no-grammar file exactly once, in order", async () => {
    const lines = plainText(90);
    const { chunks } = await keysOf("notes/example.txt", lines);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeGreaterThan(chunks[i - 1].endLine);
    }
    const covered = chunks.flatMap((chunk) => lines.slice(chunk.startLine, chunk.endLine + 1));
    expect(covered.join("\n")).toBe(chunks.map((chunk) => chunk.content).join("\n"));
    expect(covered.filter((line) => line.trim()).length).toBe(lines.filter((line) => line.trim()).length);
  });
});
