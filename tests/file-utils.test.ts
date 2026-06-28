import { describe, expect, it } from "vitest";
import { MAX_FILE_SIZE_BYTES } from "../src/config";
import {
  computeBufferHash,
  computeContentHash,
  formatDenseSnippet,
  hasNullByte,
  isIndexableFile,
  stripMarkdownFrontmatter,
} from "../src/lib/utils/file-utils";

describe("computeBufferHash", () => {
  it("returns consistent SHA256 hex for known input", () => {
    const hash = computeBufferHash(Buffer.from("hello"));
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("returns hash for empty buffer", () => {
    const hash = computeBufferHash(Buffer.alloc(0));
    expect(hash).toHaveLength(64);
  });

  it("returns different hashes for different inputs", () => {
    const a = computeBufferHash(Buffer.from("a"));
    const b = computeBufferHash(Buffer.from("b"));
    expect(a).not.toBe(b);
  });
});

describe("stripMarkdownFrontmatter", () => {
  const body = "# Title\n\nBody text.\n";

  it("strips a leading YAML frontmatter block", () => {
    const withFm = `---\nstatus: active\ntags: [a, b]\n---\n${body}`;
    expect(stripMarkdownFrontmatter(Buffer.from(withFm)).toString()).toBe(body);
  });

  it("handles a closing `...` fence", () => {
    const withFm = `---\nstatus: active\n...\n${body}`;
    expect(stripMarkdownFrontmatter(Buffer.from(withFm)).toString()).toBe(body);
  });

  it("tolerates CRLF line endings and a leading BOM", () => {
    const withFm = `\uFEFF---\r\nstatus: active\r\n---\r\n${body}`;
    expect(stripMarkdownFrontmatter(Buffer.from(withFm)).toString()).toBe(body);
  });

  it("leaves a doc without frontmatter untouched", () => {
    expect(stripMarkdownFrontmatter(Buffer.from(body)).toString()).toBe(body);
  });

  it("does NOT strip a leading thematic break with no closing fence", () => {
    // A bare `startsWith('---')` heuristic would wrongly eat this; the whole-line
    // + closing-fence requirement leaves it intact.
    const doc = "---\nNot frontmatter, just a rule.\n";
    expect(stripMarkdownFrontmatter(Buffer.from(doc)).toString()).toBe(doc);
  });

  it("does not treat `--- text` (not a whole line) as a fence", () => {
    const doc = "--- not a fence\nstuff\n--- nope\n";
    expect(stripMarkdownFrontmatter(Buffer.from(doc)).toString()).toBe(doc);
  });
});

describe("computeContentHash", () => {
  const a = `---\nstatus: draft\n---\n# Doc\n\nContent.\n`;
  const b = `---\nstatus: published\ntags: [x]\n---\n# Doc\n\nContent.\n`;

  it("is invariant to markdown frontmatter-only edits", () => {
    expect(computeContentHash(Buffer.from(a), "notes.md")).toBe(
      computeContentHash(Buffer.from(b), "notes.md"),
    );
  });

  it("still changes when markdown body content changes", () => {
    const c = `---\nstatus: draft\n---\n# Doc\n\nDifferent.\n`;
    expect(computeContentHash(Buffer.from(a), "notes.md")).not.toBe(
      computeContentHash(Buffer.from(c), "notes.md"),
    );
  });

  it("applies to .mdx as well", () => {
    expect(computeContentHash(Buffer.from(a), "notes.mdx")).toBe(
      computeContentHash(Buffer.from(b), "notes.mdx"),
    );
  });

  it("hashes exact bytes for non-markdown files (frontmatter-like content kept)", () => {
    // A .ts file that happens to start with `---` lines must hash verbatim.
    const ts = `---\nx\n---\ncode\n`;
    expect(computeContentHash(Buffer.from(ts), "weird.ts")).toBe(
      computeBufferHash(Buffer.from(ts)),
    );
  });
});

describe("hasNullByte", () => {
  it("returns true when buffer contains null byte", () => {
    expect(hasNullByte(Buffer.from([65, 0, 66]))).toBe(true);
  });

  it("returns false when buffer has no null byte", () => {
    expect(hasNullByte(Buffer.from("hello world"))).toBe(false);
  });

  it("returns false when null byte is beyond sampleLength", () => {
    const buf = Buffer.alloc(100, 65); // all 'A'
    buf[50] = 0;
    expect(hasNullByte(buf, 10)).toBe(false);
  });

  it("returns false for empty buffer", () => {
    expect(hasNullByte(Buffer.alloc(0))).toBe(false);
  });

  it("detects null byte at position 0", () => {
    expect(hasNullByte(Buffer.from([0, 65, 66]))).toBe(true);
  });
});

describe("isIndexableFile", () => {
  it("returns true for .ts file with valid size", () => {
    expect(isIndexableFile("src/main.ts", 1000)).toBe(true);
  });

  it("returns false for size 0", () => {
    expect(isIndexableFile("src/main.ts", 0)).toBe(false);
  });

  it("returns false for size exceeding MAX_FILE_SIZE_BYTES", () => {
    expect(isIndexableFile("src/main.ts", MAX_FILE_SIZE_BYTES + 1)).toBe(false);
  });

  it("returns true at exactly MAX_FILE_SIZE_BYTES", () => {
    expect(isIndexableFile("src/main.ts", MAX_FILE_SIZE_BYTES)).toBe(true);
  });

  it("returns false for unknown extension", () => {
    expect(isIndexableFile("data.xyz", 1000)).toBe(false);
  });

  it("returns true for .py file", () => {
    expect(isIndexableFile("script.py", 500)).toBe(true);
  });

  it("returns true for .json file", () => {
    expect(isIndexableFile("config.json", 200)).toBe(true);
  });
});

describe("formatDenseSnippet", () => {
  it("returns short text unchanged", () => {
    expect(formatDenseSnippet("hello")).toBe("hello");
  });

  it("truncates long text with ellipsis", () => {
    const long = "a".repeat(2000);
    const result = formatDenseSnippet(long);
    expect(result).toHaveLength(1503); // 1500 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("returns empty string for empty input", () => {
    expect(formatDenseSnippet("")).toBe("");
  });

  it("does not truncate at exact maxLength", () => {
    const exact = "a".repeat(1500);
    expect(formatDenseSnippet(exact)).toBe(exact);
  });

  it("respects custom maxLength", () => {
    const result = formatDenseSnippet("hello world", 5);
    expect(result).toBe("hello...");
  });
});
