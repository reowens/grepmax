import { describe, expect, it } from "vitest";
import { annotateSkeletonLines } from "../src/lib/skeleton/annotator";

describe("annotateSkeletonLines", () => {
  it("prefixes code lines with source line numbers", () => {
    const source = `import { foo } from "./foo";

export function bar() {
  return foo();
}`;
    const skeleton = `export function bar() {
  // ...
}`;
    const result = annotateSkeletonLines(skeleton, source);
    expect(result).toContain("   3│export function bar()");
  });

  it("leaves comment lines unchanged", () => {
    const source = "function foo() {}";
    const skeleton = "// This is a comment\nfunction foo() {}";
    const result = annotateSkeletonLines(skeleton, source);
    expect(result).toContain("// This is a comment");
    expect(result).not.toMatch(/\d+│\/\/ This is a comment/);
  });

  it("leaves empty lines unchanged", () => {
    const source = "function foo() {}\n\nfunction bar() {}";
    const skeleton = "function foo() {}\n\nfunction bar() {}";
    const result = annotateSkeletonLines(skeleton, source);
    const lines = result.split("\n");
    expect(lines[1]).toBe("");
  });

  it("matches duplicate source lines in order", () => {
    const source = `function a() {}
function b() {}
function a() {}`;
    const skeleton = `function a() {}
function a() {}`;
    const result = annotateSkeletonLines(skeleton, source);
    const lines = result.split("\n");
    // First match → line 1, second match → line 3 (skips used line 1)
    expect(lines[0]).toContain("1│");
    expect(lines[1]).toContain("3│");
  });
});
