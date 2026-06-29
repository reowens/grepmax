import { describe, expect, it } from "vitest";
import {
  findDependents,
  findTests,
  isTestPath,
  resolveTargetSymbols,
} from "../src/lib/graph/impact";

function createMockDb(data: Record<string, any[]>) {
  const mockTable = {
    query: () => {
      let whereClause = "";
      let limitVal = 100;
      const chain = {
        where: (clause: string) => {
          whereClause = clause;
          return chain;
        },
        select: () => chain,
        limit: (n: number) => {
          limitVal = n;
          return chain;
        },
        toArray: async () => {
          for (const [pattern, rows] of Object.entries(data)) {
            if (whereClause.includes(pattern)) return rows.slice(0, limitVal);
          }
          return [];
        },
      };
      return chain;
    },
  };
  return { ensureTable: async () => mockTable } as any;
}

function makeRow(
  symbol: string,
  file: string,
  line: number,
  refs: string[] = [],
) {
  return {
    path: file,
    start_line: line,
    defined_symbols: [symbol],
    referenced_symbols: refs,
    role: "ORCHESTRATION",
    parent_symbol: null,
    complexity: 1,
  };
}

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

describe("resolveTargetSymbols", () => {
  it("returns symbol directly for non-file input", async () => {
    const db = createMockDb({});
    const result = await resolveTargetSymbols("handleAuth", db, "/project");
    expect(result.symbols).toEqual(["handleAuth"]);
    expect(result.resolvedAsFile).toBe(false);
  });

  it("resolves symbols from file path", async () => {
    const db = createMockDb({
      "/project/src/auth.ts": [
        { defined_symbols: ["handleAuth", "validateToken"] },
      ],
    });
    const result = await resolveTargetSymbols("src/auth.ts", db, "/project");
    expect(result.resolvedAsFile).toBe(true);
    expect(result.symbols).toContain("handleAuth");
    expect(result.symbols).toContain("validateToken");
    expect(result.symbolFamilies?.get("handleAuth")).toBe("js_ts");
  });

  it("returns empty for unindexed file", async () => {
    const db = createMockDb({});
    const result = await resolveTargetSymbols("src/missing.ts", db, "/project");
    expect(result.resolvedAsFile).toBe(true);
    expect(result.symbols).toEqual([]);
  });
});

describe("findDependents", () => {
  it("finds files that reference target symbols", async () => {
    const db = createMockDb({
      "referenced_symbols, 'handleAuth'": [
        { path: "/project/src/router.ts" },
        { path: "/project/src/middleware.ts" },
      ],
    });
    const result = await findDependents(["handleAuth"], db, "/project");
    expect(result.length).toBe(2);
    expect(result[0].file).toBe("/project/src/router.ts");
    expect(result[0].sharedSymbols).toBe(1);
  });

  it("counts each target symbol once per dependent file", async () => {
    const db = createMockDb({
      "referenced_symbols, 'Foo'": [
        { path: "/project/src/use.ts" },
        { path: "/project/src/use.ts" },
      ],
      "referenced_symbols, 'Bar'": [{ path: "/project/src/use.ts" }],
    });

    const result = await findDependents(["Foo", "Bar"], db, "/project");

    expect(result).toEqual([{ file: "/project/src/use.ts", sharedSymbols: 2 }]);
  });

  it("excludes specified paths", async () => {
    const db = createMockDb({
      "referenced_symbols, 'handleAuth'": [
        { path: "/project/src/auth.ts" },
        { path: "/project/src/router.ts" },
      ],
    });
    const exclude = new Set(["/project/src/auth.ts"]);
    const result = await findDependents(
      ["handleAuth"],
      db,
      "/project",
      exclude,
    );
    expect(result.length).toBe(1);
    expect(result[0].file).toBe("/project/src/router.ts");
  });

  it("filters same-name dependents to the target definition family", async () => {
    const db = createMockDb({
      "defined_symbols, 'render'": [
        makeRow("render", "/project/src/view.py", 1),
      ],
      "referenced_symbols, 'render'": [
        { path: "/project/src/Widget.tsx" },
        { path: "/project/src/cli.py" },
      ],
    });

    const result = await findDependents(["render"], db, "/project");

    expect(result.map((r) => r.file)).toEqual(["/project/src/cli.py"]);
  });
});

describe("findTests", () => {
  it("does not count cross-language test callers for same-name symbols", async () => {
    const db = createMockDb({
      "defined_symbols, 'render'": [
        makeRow("render", "/project/src/view.py", 1),
      ],
      "/project/src/view.py": [{ defined_symbols: ["render"] }],
      "referenced_symbols, 'render'": [
        makeRow("testWidget", "/project/tests/widget.test.tsx", 10, ["render"]),
        makeRow("test_render", "/project/tests/view.test.py", 12, ["render"]),
      ],
    });

    const result = await findTests(["render"], db, "/project");

    expect(result.map((r) => r.file)).toEqual(["/project/tests/view.test.py"]);
  });
});
