import { describe, expect, it } from "vitest";
import type { SearchIntent } from "../src/lib/search/intent";
import { asSymbolQuery, buildWhereClause } from "../src/lib/search/searcher";

const defaultIntent: SearchIntent = { type: "GENERAL" };

describe("asSymbolQuery", () => {
  it("accepts bare identifiers (symbol lookups)", () => {
    for (const q of [
      "BeyondError",
      "ErrorCodes",
      "map",
      "requireAuth",
      "_private",
      "$jq",
      "a1_b2",
    ]) {
      expect(asSymbolQuery(q)).toBe(q);
    }
  });

  it("trims surrounding whitespace", () => {
    expect(asSymbolQuery("  BeyondError  ")).toBe("BeyondError");
  });

  it("rejects natural-language and multi-token queries", () => {
    for (const q of [
      "how does auth work",
      "create application",
      "BeyondError extends",
      "a.b",
      "foo()",
      "1abc",
      "",
    ]) {
      expect(asSymbolQuery(q)).toBeNull();
    }
  });
});

describe("buildWhereClause", () => {
  it("returns undefined with no filters or prefix", () => {
    expect(
      buildWhereClause(undefined, undefined, defaultIntent),
    ).toBeUndefined();
  });

  it("builds path prefix starts_with clause", () => {
    const result = buildWhereClause("/usr/src/", undefined, defaultIntent);
    expect(result).toBe("starts_with(path, '/usr/src/')");
  });

  it("builds file name filter", () => {
    const result = buildWhereClause(
      undefined,
      { file: "syncer.ts" },
      defaultIntent,
    );
    expect(result).toBe("path LIKE '%/syncer.ts'");
  });

  it("builds exclude clause with path prefix", () => {
    const result = buildWhereClause(
      "/usr/src/",
      { exclude: "tests/" },
      defaultIntent,
    );
    expect(result).toContain("starts_with(path, '/usr/src/')");
    expect(result).toContain("NOT starts_with(path, '/usr/src/tests/')");
  });

  it("builds exclude clause without path prefix", () => {
    const result = buildWhereClause(
      undefined,
      { exclude: "dist/" },
      defaultIntent,
    );
    expect(result).toBe("NOT starts_with(path, 'dist/')");
  });

  it("builds language extension filter", () => {
    const result = buildWhereClause(
      undefined,
      { language: "ts" },
      defaultIntent,
    );
    expect(result).toBe("path LIKE '%.ts'");
  });

  it("handles language filter with leading dot", () => {
    const result = buildWhereClause(
      undefined,
      { language: ".py" },
      defaultIntent,
    );
    expect(result).toBe("path LIKE '%.py'");
  });

  it("builds role exact match", () => {
    const result = buildWhereClause(
      undefined,
      { role: "ORCHESTRATION" },
      defaultIntent,
    );
    expect(result).toBe("role = 'ORCHESTRATION'");
  });

  it("builds project_roots OR clause", () => {
    const result = buildWhereClause(
      undefined,
      { project_roots: "/a,/b" },
      defaultIntent,
    );
    expect(result).toBe(
      "(starts_with(path, '/a/') OR starts_with(path, '/b/'))",
    );
  });

  it("builds explicit projectRoots OR clause", () => {
    const result = buildWhereClause(
      undefined,
      { projectRoots: ["/a", "/b"] },
      defaultIntent,
    );
    expect(result).toBe(
      "(starts_with(path, '/a/') OR starts_with(path, '/b/'))",
    );
  });

  it("fails closed for an explicit empty projectRoots array", () => {
    expect(
      buildWhereClause(undefined, { projectRoots: [] }, defaultIntent),
    ).toBe("1 = 0");
  });

  it("prefers projectRoots over the legacy CSV shape", () => {
    const result = buildWhereClause(
      undefined,
      { projectRoots: ["/safe"], project_roots: "/unsafe" },
      defaultIntent,
    );
    expect(result).toBe("(starts_with(path, '/safe/'))");
  });

  it("builds exclude_project_roots exclusion clauses", () => {
    const result = buildWhereClause(
      undefined,
      { exclude_project_roots: "/a,/b" },
      defaultIntent,
    );
    expect(result).toContain("NOT starts_with(path, '/a/')");
    expect(result).toContain("NOT starts_with(path, '/b/')");
  });

  it("builds def filter with array_contains", () => {
    const result = buildWhereClause(
      undefined,
      { def: "myFunc" },
      defaultIntent,
    );
    expect(result).toBe("array_contains(defined_symbols, 'myFunc')");
  });

  it("builds ref filter with array_contains", () => {
    const result = buildWhereClause(
      undefined,
      { ref: "otherFunc" },
      defaultIntent,
    );
    expect(result).toBe("array_contains(referenced_symbols, 'otherFunc')");
  });

  it("composes multiple filters with AND", () => {
    const result = buildWhereClause(
      "/src/",
      { language: "ts", role: "ORCHESTRATION" },
      defaultIntent,
    );
    expect(result).toContain("starts_with(path, '/src/')");
    expect(result).toContain("path LIKE '%.ts'");
    expect(result).toContain("role = 'ORCHESTRATION'");
    expect(result!.split(" AND ").length).toBe(3);
  });

  it("escapes single quotes in filter values", () => {
    const result = buildWhereClause(
      undefined,
      { file: "it's.ts" },
      defaultIntent,
    );
    expect(result).toBe("path LIKE '%/it''s.ts'");
  });

  it("handles DEFINITION intent with definitionsOnly", () => {
    const intent: SearchIntent = {
      type: "DEFINITION",
      filters: { definitionsOnly: true },
    };
    const result = buildWhereClause(undefined, undefined, intent);
    expect(result).toBe(
      "(role = 'DEFINITION' OR array_length(defined_symbols) > 0)",
    );
  });

  it("emits multiple exclusions for excludePrefixes array", () => {
    const result = buildWhereClause(
      "/p/app/",
      { excludePrefixes: ["/p/app/tests/", "/p/app/docs/"] },
      defaultIntent,
    );
    expect(result).toContain("starts_with(path, '/p/app/')");
    expect(result).toContain("NOT starts_with(path, '/p/app/tests/')");
    expect(result).toContain("NOT starts_with(path, '/p/app/docs/')");
  });

  it("emits OR group for multi-element inPrefixes", () => {
    const result = buildWhereClause(
      "/p/app/",
      {
        inPrefixes: ["/p/app/packages/api/", "/p/app/packages/web/"],
      },
      defaultIntent,
    );
    expect(result).toContain(
      "(starts_with(path, '/p/app/packages/api/') OR starts_with(path, '/p/app/packages/web/'))",
    );
  });

  it("def filter overrides DEFINITION intent", () => {
    const intent: SearchIntent = {
      type: "DEFINITION",
      filters: { definitionsOnly: true },
    };
    const result = buildWhereClause(undefined, { def: "MyClass" }, intent);
    expect(result).toBe("array_contains(defined_symbols, 'MyClass')");
  });
});
