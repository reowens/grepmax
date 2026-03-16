import { describe, expect, it } from "vitest";
import {
  escapeSqlString,
  normalizePath,
} from "../src/lib/utils/filter-builder";

describe("escapeSqlString", () => {
  it("returns input unchanged when no single quotes", () => {
    expect(escapeSqlString("hello world")).toBe("hello world");
  });

  it("doubles single quotes", () => {
    expect(escapeSqlString("it's")).toBe("it''s");
  });

  it("doubles multiple single quotes", () => {
    expect(escapeSqlString("it's a 'test'")).toBe("it''s a ''test''");
  });

  it("handles empty string", () => {
    expect(escapeSqlString("")).toBe("");
  });

  it("leaves backslashes untouched", () => {
    expect(escapeSqlString("path\\to\\file")).toBe("path\\to\\file");
  });
});

describe("normalizePath", () => {
  it("replaces backslashes with forward slashes", () => {
    expect(normalizePath("src\\lib\\utils")).toBe("src/lib/utils");
  });

  it("leaves forward slashes unchanged", () => {
    expect(normalizePath("src/lib/utils")).toBe("src/lib/utils");
  });

  it("handles mixed slashes", () => {
    expect(normalizePath("src\\lib/utils\\file.ts")).toBe(
      "src/lib/utils/file.ts",
    );
  });

  it("handles empty string", () => {
    expect(normalizePath("")).toBe("");
  });
});
