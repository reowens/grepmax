import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/project-root", () => ({
  ensureProjectPaths: vi.fn(() => ({
    root: "/proj",
    dataDir: "/proj/.gmax",
    lancedbDir: "/proj/.gmax/lancedb",
    cacheDir: "/proj/.gmax/cache",
    lmdbPath: "/proj/.gmax/cache/meta.lmdb",
    configPath: "/proj/.gmax/config.json",
  })),
  findProjectRoot: vi.fn(() => "/proj"),
}));

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

interface Row {
  path?: string;
  defined_symbols?: string[];
  referenced_symbols?: string[];
}

function makeQuery(matches: Array<{ pattern: string; rows: Row[] }>) {
  return () => {
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
        for (const m of matches) {
          if (whereClause.includes(m.pattern)) return m.rows.slice(0, limitVal);
        }
        return [];
      },
    };
    return chain;
  };
}

let mockMatches: Array<{ pattern: string; rows: Row[] }> = [];

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(function () {
    return {
      ensureTable: async () => ({ query: makeQuery(mockMatches) }),
      close: vi.fn(async () => {}),
    };
  }),
}));

import { related } from "../src/commands/related";

describe("related command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMatches = [];
    (related as Command).exitOverride();
  });

  it("emits dep:/rev: lines when symbol intersection finds neighbors", async () => {
    mockMatches = [
      // file lookup (the input file itself)
      {
        pattern: "path = '/proj/src/lib/foo.ts'",
        rows: [{ defined_symbols: ["Foo"], referenced_symbols: ["Bar"] }],
      },
      // dependencies: who defines 'Bar'
      {
        pattern: "array_contains(defined_symbols, 'Bar')",
        rows: [{ path: "/proj/src/lib/bar.ts" }],
      },
      // dependents: who references 'Foo'
      {
        pattern: "array_contains(referenced_symbols, 'Foo')",
        rows: [{ path: "/proj/src/app/uses-foo.ts" }],
      },
    ];

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (related as Command).parseAsync(["src/lib/foo.ts", "--agent"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("dep: src/lib/bar.ts");
    expect(output).toContain("rev: src/app/uses-foo.ts");
    expect(output).not.toContain("(none)");
    expect(output).not.toContain("mentioning");
    spy.mockRestore();
  });

  it("falls back to basename mentions when both directions are empty", async () => {
    mockMatches = [
      {
        pattern: "path = '/proj/src/lib/widget.ts'",
        rows: [{ defined_symbols: [], referenced_symbols: [] }],
      },
      // basename mentions
      {
        pattern: "content LIKE '%widget%'",
        rows: [
          { path: "/proj/src/app/page.tsx" },
          { path: "/proj/src/lib/widget.ts" }, // self, must be skipped
          { path: "/proj/tests/widget.test.ts" },
        ],
      },
    ];

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (related as Command).parseAsync(["src/lib/widget.ts", "--agent"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain(
      "(no semantic neighbors; showing 2 files mentioning 'widget')",
    );
    expect(output).toContain("imp: src/app/page.tsx");
    expect(output).toContain("imp: tests/widget.test.ts");
    expect(output).not.toContain("imp: src/lib/widget.ts");
    spy.mockRestore();
  });

  it("rejects generic basenames (e.g. index) instead of dumping noise", async () => {
    mockMatches = [
      {
        pattern: "path = '/proj/src/index.ts'",
        rows: [{ defined_symbols: [], referenced_symbols: [] }],
      },
    ];

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (related as Command).parseAsync(["src/index.ts", "--agent"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain(
      "(no semantic neighbors; basename 'index' too generic to fall back)",
    );
    expect(output).not.toContain("imp:");
    spy.mockRestore();
  });

  it("emits human-mode 'Mentions of \"X\"' section when both empty", async () => {
    mockMatches = [
      {
        pattern: "path = '/proj/src/lib/widget.ts'",
        rows: [{ defined_symbols: [], referenced_symbols: [] }],
      },
      {
        pattern: "content LIKE '%widget%'",
        rows: [{ path: "/proj/src/app/page.tsx" }],
      },
    ];

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (related as Command).parseAsync(["src/lib/widget.ts"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain('Mentions of "widget" in other files:');
    expect(output).toContain("src/app/page.tsx");
    spy.mockRestore();
  });
});
