import { describe, expect, it } from "vitest";
import {
  buildAnchorChunk,
  formatChunkText,
  TreeSitterChunker,
} from "../src/lib/index/chunker";

describe("TreeSitterChunker fallback and splitting", () => {
  it("splits large text into overlapping chunks with preserved ordering", async () => {
    const chunker = new TreeSitterChunker() as any;
    // Skip init and force fallback path
    chunker.initialized = true;
    chunker.parser = null;

    const lines = Array.from({ length: 220 }, (_, i) => `line-${i + 1}`);
    const content = lines.join("\n");

    const { chunks } = await chunker.chunk("file.ts", content);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].startLine).toBe(0);
    expect(chunks[0].endLine).toBeGreaterThan(chunks[0].startLine);
    // Ensure monotonic progression and overlap
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine);
      expect(chunks[i].endLine).toBeGreaterThan(chunks[i].startLine);
    }
  });

  it("splits very long single-line content by characters", async () => {
    const chunker = new TreeSitterChunker() as any;
    chunker.initialized = true;
    chunker.parser = null;

    const content = "a".repeat(3500);
    const { chunks } = await chunker.chunk("file.txt", content);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].content.length).toBeLessThanOrEqual(2000);
  });

  it("scopes sub-chunk symbol lists to their content slice", () => {
    const chunker = new TreeSitterChunker() as any;

    const lines: string[] = ["class Daemon {"];
    lines.push("  start() { isFileCached(); }");
    for (let i = 0; i < 200; i++) lines.push(`  // filler ${i}`);
    lines.push("  shutdown() { closeAll(); }");
    lines.push("}");

    const subs = chunker.splitIfTooBig({
      content: lines.join("\n"),
      startLine: 0,
      endLine: lines.length - 1,
      type: "class",
      definedSymbols: ["Daemon", "start", "shutdown"],
      referencedSymbols: ["isFileCached", "closeAll"],
    });

    expect(subs.length).toBeGreaterThan(1);

    // No sub-chunk may claim a symbol that does not occur in its own slice —
    // inherited full lists fabricate one phantom graph edge per sub-chunk.
    for (const sc of subs) {
      for (const s of [...sc.definedSymbols, ...sc.referencedSymbols]) {
        expect(sc.content).toMatch(new RegExp(`\\b${s}\\b`));
      }
    }

    // The reference must survive in the sub-chunk(s) containing the call
    // site, and must NOT be smeared across all sub-chunks.
    const withRef = subs.filter((sc: any) =>
      sc.referencedSymbols.includes("isFileCached"),
    );
    expect(withRef.length).toBeGreaterThan(0);
    expect(withRef.length).toBeLessThan(subs.length);
    const withShutdown = subs.filter((sc: any) =>
      sc.definedSymbols.includes("shutdown"),
    );
    expect(withShutdown.length).toBeGreaterThan(0);
    expect(withShutdown.length).toBeLessThan(subs.length);
  });
});

describe("LocalStore chunk formatting helpers", () => {
  it("buildAnchorChunk includes imports, exports, and top comments", () => {
    const content = `// top comment
import fs from "fs";
export const value = 1;
function example() {}`;

    const anchor = buildAnchorChunk("src/example.ts", content, {
      imports: ["fs"],
      exports: ["value"],
      comments: ["// top comment"],
    });

    expect(anchor.isAnchor).toBe(true);
    expect(anchor.context).toContain("Anchor");
    expect(anchor.content).toContain("Imports:");
    expect(anchor.content).toContain("Exports: value");
    expect(anchor.content).toContain("Top comments:");
  });

  it("indexes exported const declarations regardless of RHS shape", async () => {
    const chunker = new TreeSitterChunker();
    const content = [
      "export const typeDefs = `",
      "  type Query { hello: String }",
      "`;",
      "",
      "export const config = { foo: 1 };",
      "",
      "export const upper = lower.toUpperCase();",
    ].join("\n");

    const { chunks } = await chunker.chunk("schema.ts", content);
    const defined = chunks.flatMap((c) => c.definedSymbols ?? []);
    expect(defined).toContain("typeDefs");
    expect(defined).toContain("config");
    expect(defined).toContain("upper");
  });

  it("formatChunkText adds file breadcrumb when missing", () => {
    const { displayText } = formatChunkText(
      {
        content: "code",
        context: [],
        startLine: 0,
        endLine: 0,
        type: "other",
      },
      "/repo/path/file.ts",
    );
    expect(displayText).toContain("// /repo/path/file.ts");
    expect(displayText).toContain("File: /repo/path/file.ts");
    expect(displayText).toContain("code");
  });
});

describe("TreeSitterChunker identifier-as-value references (TS/JS)", () => {
  const SOURCE = `import { BeyondError, ErrorCodes } from "./errors";

export function handle(x: unknown) {
  if (x instanceof BeyondError) {
    throw new BeyondError(ErrorCodes.VALIDATION, "bad");
  }
  const code = ErrorCodes.NOT_FOUND;
  logger.error(code);
  this.cache.clear();
  return new Foo.Bar();
}
`;

  it("captures new / instanceof / member-access class references", async () => {
    const chunker = new TreeSitterChunker();
    const { chunks } = await chunker.chunk("handler.ts", SOURCE);
    const chunk = chunks.find((c) => c.definedSymbols?.includes("handle"));
    expect(chunk).toBeDefined();
    const refs = chunk?.referencedSymbols ?? [];

    // new ClassName(...) and `instanceof ClassName`
    expect(refs).toContain("BeyondError");
    // Enum.MEMBER / ClassName.MEMBER object captured (twice in source -> deduped)
    expect(refs).toContain("ErrorCodes");
    expect(refs.filter((r) => r === "ErrorCodes")).toHaveLength(1);
    // `new ns.ClassName()` captures both the namespace and the constructor
    expect(refs).toContain("Foo");
    expect(refs).toContain("Bar");
  });

  it("does not capture lowercase objects or `this` as references", async () => {
    const chunker = new TreeSitterChunker();
    const { chunks } = await chunker.chunk("handler.ts", SOURCE);
    const chunk = chunks.find((c) => c.definedSymbols?.includes("handle"));
    const refs = chunk?.referencedSymbols ?? [];

    // member-access object capture is gated to Capitalized identifiers
    expect(refs).not.toContain("logger");
    expect(refs).not.toContain("this");
    expect(refs).not.toContain("cache");
    // existing call-expression coverage stays intact
    expect(refs).toContain("error"); // logger.error(...)
    expect(refs).toContain("clear"); // this.cache.clear()
  });
});
