import { describe, expect, it } from "vitest";
import { isTestPath } from "../src/lib/graph/impact";

describe("isTestPath", () => {
  it("detects __tests__ directory", () => {
    expect(isTestPath("/src/__tests__/auth.ts")).toBe(true);
  });

  it("detects tests/ directory", () => {
    expect(isTestPath("/project/tests/auth.test.ts")).toBe(true);
  });

  it("detects test/ directory", () => {
    expect(isTestPath("/project/test/auth.ts")).toBe(true);
  });

  it("detects .test.ts files", () => {
    expect(isTestPath("/src/auth.test.ts")).toBe(true);
  });

  it("detects .spec.js files", () => {
    expect(isTestPath("/src/auth.spec.js")).toBe(true);
  });

  it("detects .test.tsx files", () => {
    expect(isTestPath("/src/Component.test.tsx")).toBe(true);
  });

  it("detects benchmark directory", () => {
    expect(isTestPath("/project/benchmark/perf.ts")).toBe(true);
  });

  it("rejects normal source files", () => {
    expect(isTestPath("/src/auth.ts")).toBe(false);
  });

  it("rejects files with test in the name but not as suffix", () => {
    expect(isTestPath("/src/testing-utils.ts")).toBe(false);
  });

  it("is case insensitive for directories", () => {
    expect(isTestPath("/project/Tests/auth.ts")).toBe(true);
  });
});
