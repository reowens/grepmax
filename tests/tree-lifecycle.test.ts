import { describe, expect, it } from "vitest";
import { TreeSitterChunker } from "../src/lib/index/chunker";
import { Skeletonizer } from "../src/lib/skeleton/skeletonizer";

interface TreeCounts {
  parseCalls: number;
  trees: number;
  deletes: number;
}

function instrumentParser(
  owner: { parser: any },
  behavior: "normal" | "null" | "throw-on-root" = "normal",
): TreeCounts {
  const counts: TreeCounts = { parseCalls: 0, trees: 0, deletes: 0 };
  const parser = owner.parser;
  expect(parser).toBeTruthy();
  const originalParse = parser.parse.bind(parser);

  parser.parse = (content: string) => {
    counts.parseCalls++;
    if (behavior === "null") return null;

    const tree = originalParse(content);
    if (!tree) return null;
    counts.trees++;

    return {
      get rootNode() {
        if (behavior === "throw-on-root") throw new Error("traversal failed");
        return tree.rootNode;
      },
      delete() {
        counts.deletes++;
        tree.delete();
      },
    };
  };

  return counts;
}

function expectEveryTreeDeleted(counts: TreeCounts): void {
  expect(counts.deletes).toBe(counts.trees);
}

describe("TreeSitterChunker tree lifecycle", () => {
  it("deletes the tree after successful chunking", async () => {
    const chunker = new TreeSitterChunker();
    await chunker.init();
    const counts = instrumentParser(chunker as any);

    const result = await chunker.chunk(
      "/tmp/lifecycle.ts",
      "export function greet() { return 'hello'; }",
    );

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(counts.parseCalls).toBe(1);
    expectEveryTreeDeleted(counts);
  });

  it("deletes the tree on the no-definitions early return", async () => {
    const chunker = new TreeSitterChunker();
    await chunker.init();
    const counts = instrumentParser(chunker as any);

    await chunker.chunk("/tmp/lifecycle.ts", "console.log('hello');");

    expect(counts.parseCalls).toBe(1);
    expectEveryTreeDeleted(counts);
  });

  it("deletes the tree when traversal throws", async () => {
    const chunker = new TreeSitterChunker();
    await chunker.init();
    const counts = instrumentParser(chunker as any, "throw-on-root");

    await chunker.chunk("/tmp/lifecycle.ts", "export function greet() {}");

    expect(counts.parseCalls).toBe(1);
    expectEveryTreeDeleted(counts);
  });

  it("handles a null parse result without deleting", async () => {
    const chunker = new TreeSitterChunker();
    await chunker.init();
    const counts = instrumentParser(chunker as any, "null");

    await chunker.chunk("/tmp/lifecycle.ts", "export function greet() {}");

    expect(counts).toEqual({ parseCalls: 1, trees: 0, deletes: 0 });
  });

  it("deletes exactly one tree per file over repeated use", async () => {
    const chunker = new TreeSitterChunker();
    await chunker.init();
    const counts = instrumentParser(chunker as any);

    for (let i = 0; i < 50; i++) {
      await chunker.chunk(
        `/tmp/lifecycle-${i}.ts`,
        `export function value${i}() { return ${i}; }`,
      );
    }

    expect(counts.parseCalls).toBe(50);
    expect(counts.trees).toBe(50);
    expectEveryTreeDeleted(counts);
  });
});

describe("Skeletonizer tree lifecycle", () => {
  it("deletes the tree after successful skeletonization", async () => {
    const skeletonizer = new Skeletonizer();
    await skeletonizer.init();
    const counts = instrumentParser(skeletonizer as any);

    const result = await skeletonizer.skeletonizeFile(
      "/tmp/lifecycle.ts",
      "export function greet() { return 'hello'; }",
    );

    expect(result.success).toBe(true);
    expect(counts.parseCalls).toBe(1);
    expectEveryTreeDeleted(counts);
  });

  it("deletes the tree on the zero-elisions early return", async () => {
    const skeletonizer = new Skeletonizer();
    await skeletonizer.init();
    const counts = instrumentParser(skeletonizer as any);

    await skeletonizer.skeletonizeFile(
      "/tmp/lifecycle.ts",
      "export const answer = 42;",
    );

    expect(counts.parseCalls).toBe(1);
    expectEveryTreeDeleted(counts);
  });

  it("deletes the tree when traversal throws", async () => {
    const skeletonizer = new Skeletonizer();
    await skeletonizer.init();
    const counts = instrumentParser(skeletonizer as any, "throw-on-root");

    const result = await skeletonizer.skeletonizeFile(
      "/tmp/lifecycle.ts",
      "export function greet() {}",
    );

    expect(result.success).toBe(false);
    expect(counts.parseCalls).toBe(1);
    expectEveryTreeDeleted(counts);
  });

  it("handles a null parse result without deleting", async () => {
    const skeletonizer = new Skeletonizer();
    await skeletonizer.init();
    const counts = instrumentParser(skeletonizer as any, "null");

    const result = await skeletonizer.skeletonizeFile(
      "/tmp/lifecycle.ts",
      "export function greet() {}",
    );

    expect(result.success).toBe(false);
    expect(counts).toEqual({ parseCalls: 1, trees: 0, deletes: 0 });
  });
});
