import { describe, expect, it } from "vitest";
import {
  escapeSqlString,
  normalizePath,
  pathNotStartsWith,
  pathStartsWith,
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

describe("pathStartsWith", () => {
  it("emits a starts_with predicate, not a LIKE clause", () => {
    expect(pathStartsWith("/repo/app/")).toBe(
      "starts_with(path, '/repo/app/')",
    );
  });

  it("keeps `_` literal so a sibling project can't be matched", () => {
    // `path LIKE '/repo/my_app/%'` would also match `/repo/myXapp/` because `_`
    // is a LIKE wildcard. starts_with() has no wildcard semantics, so the
    // underscore is matched literally.
    expect(pathStartsWith("/repo/my_app/")).toBe(
      "starts_with(path, '/repo/my_app/')",
    );
  });

  it("keeps `%` literal", () => {
    expect(pathStartsWith("/repo/100%done/")).toBe(
      "starts_with(path, '/repo/100%done/')",
    );
  });

  it("escapes single quotes in the prefix", () => {
    expect(pathStartsWith("/repo/it's/")).toBe(
      "starts_with(path, '/repo/it''s/')",
    );
  });

  it("negates with pathNotStartsWith", () => {
    expect(pathNotStartsWith("/repo/app/tests/")).toBe(
      "NOT starts_with(path, '/repo/app/tests/')",
    );
  });
});
