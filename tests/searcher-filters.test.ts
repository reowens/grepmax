import { describe, expect, it } from "vitest";
import { buildWhereClause } from "../src/lib/search/searcher";
import type { SearchIntent } from "../src/lib/search/intent";

const defaultIntent: SearchIntent = { type: "GENERAL" };

describe("buildWhereClause", () => {
  it("returns undefined with no filters or prefix", () => {
    expect(buildWhereClause(undefined, undefined, defaultIntent)).toBeUndefined();
  });

  it("builds path prefix LIKE clause", () => {
    const result = buildWhereClause("/usr/src/", undefined, defaultIntent);
    expect(result).toBe("path LIKE '/usr/src/%'");
  });

  it("builds file name filter", () => {
    const result = buildWhereClause(undefined, { file: "syncer.ts" }, defaultIntent);
    expect(result).toBe("path LIKE '%/syncer.ts'");
  });

  it("builds exclude NOT LIKE clause with path prefix", () => {
    const result = buildWhereClause("/usr/src/", { exclude: "tests/" }, defaultIntent);
    expect(result).toContain("path LIKE '/usr/src/%'");
    expect(result).toContain("path NOT LIKE '/usr/src/tests/%'");
  });

  it("builds exclude NOT LIKE clause without path prefix", () => {
    const result = buildWhereClause(undefined, { exclude: "dist/" }, defaultIntent);
    expect(result).toBe("path NOT LIKE 'dist/%'");
  });

  it("builds language extension filter", () => {
    const result = buildWhereClause(undefined, { language: "ts" }, defaultIntent);
    expect(result).toBe("path LIKE '%.ts'");
  });

  it("handles language filter with leading dot", () => {
    const result = buildWhereClause(undefined, { language: ".py" }, defaultIntent);
    expect(result).toBe("path LIKE '%.py'");
  });

  it("builds role exact match", () => {
    const result = buildWhereClause(undefined, { role: "ORCHESTRATION" }, defaultIntent);
    expect(result).toBe("role = 'ORCHESTRATION'");
  });

  it("builds project_roots OR clause", () => {
    const result = buildWhereClause(undefined, { project_roots: "/a,/b" }, defaultIntent);
    expect(result).toBe("(path LIKE '/a/%' OR path LIKE '/b/%')");
  });

  it("builds exclude_project_roots NOT LIKE clauses", () => {
    const result = buildWhereClause(undefined, { exclude_project_roots: "/a,/b" }, defaultIntent);
    expect(result).toContain("path NOT LIKE '/a/%'");
    expect(result).toContain("path NOT LIKE '/b/%'");
  });

  it("builds def filter with array_contains", () => {
    const result = buildWhereClause(undefined, { def: "myFunc" }, defaultIntent);
    expect(result).toBe("array_contains(defined_symbols, 'myFunc')");
  });

  it("builds ref filter with array_contains", () => {
    const result = buildWhereClause(undefined, { ref: "otherFunc" }, defaultIntent);
    expect(result).toBe("array_contains(referenced_symbols, 'otherFunc')");
  });

  it("composes multiple filters with AND", () => {
    const result = buildWhereClause("/src/", { language: "ts", role: "ORCHESTRATION" }, defaultIntent);
    expect(result).toContain("path LIKE '/src/%'");
    expect(result).toContain("path LIKE '%.ts'");
    expect(result).toContain("role = 'ORCHESTRATION'");
    expect(result!.split(" AND ").length).toBe(3);
  });

  it("escapes single quotes in filter values", () => {
    const result = buildWhereClause(undefined, { file: "it's.ts" }, defaultIntent);
    expect(result).toBe("path LIKE '%/it''s.ts'");
  });

  it("handles DEFINITION intent with definitionsOnly", () => {
    const intent: SearchIntent = {
      type: "DEFINITION",
      filters: { definitionsOnly: true },
    };
    const result = buildWhereClause(undefined, undefined, intent);
    expect(result).toBe("(role = 'DEFINITION' OR array_length(defined_symbols) > 0)");
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
