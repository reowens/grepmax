import type { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

// Defining-chunk row returned by the table query inside dead.ts.
// Tests mutate this between runs.
let defRow: { path: string; start_line: number; is_exported: boolean } | null =
  null;

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(function () {
    return {
      ensureTable: async () => ({
        query: () => {
          const chain: any = {
            select: () => chain,
            where: () => chain,
            limit: () => chain,
            toArray: async () => (defRow ? [defRow] : []),
          };
          return chain;
        },
      }),
      close: vi.fn(async () => {}),
    };
  }),
}));

const getCallers = vi.fn();
vi.mock("../src/lib/graph/graph-builder", () => ({
  GraphBuilder: vi.fn(function () {
    return { getCallers };
  }),
}));

import { dead } from "../src/commands/dead";

describe("dead command", () => {
  beforeAll(() => {
    process.env.NO_COLOR = "1";
  });
  beforeEach(() => {
    vi.clearAllMocks();
    defRow = null;
    (dead as Command).exitOverride();
    process.exitCode = 0;
  });

  it("reports DEAD when symbol has zero callers and is not exported", async () => {
    defRow = {
      path: "/proj/src/util/foo.ts",
      start_line: 41,
      is_exported: false,
    };
    getCallers.mockResolvedValueOnce([]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (dead as Command).parseAsync(["foo"], { from: "user" });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toContain("DEAD");
    expect(out).toContain("src/util/foo.ts:42");
    expect(out).toContain("defines foo");
    expect(out).not.toContain("PUBLIC EXPORT");
  });

  it("downgrades to PUBLIC EXPORT when symbol has zero callers but is exported", async () => {
    defRow = {
      path: "/proj/src/api/bar.ts",
      start_line: 9,
      is_exported: true,
    };
    getCallers.mockResolvedValueOnce([]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (dead as Command).parseAsync(["bar"], { from: "user" });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toContain("PUBLIC EXPORT");
    expect(out).toContain("src/api/bar.ts:10");
    expect(out).toContain("defines bar");
    expect(out).toContain("no internal callers found");
  });

  it("reports LIVE with caller count and top-3 file:line when callers exist", async () => {
    defRow = {
      path: "/proj/src/lib/baz.ts",
      start_line: 87,
      is_exported: false,
    };
    getCallers.mockResolvedValueOnce([
      { symbol: "run", file: "/proj/src/commands/run.ts", line: 11 },
      { symbol: "alsoRun", file: "/proj/src/commands/run.ts", line: 33 },
      { symbol: "testBaz", file: "/proj/tests/baz.test.ts", line: 6 },
      // 4th caller — should not appear in top-3
      { symbol: "extra", file: "/proj/src/other.ts", line: 99 },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (dead as Command).parseAsync(["baz"], { from: "user" });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toContain("LIVE");
    expect(out).toContain("src/lib/baz.ts:88");
    expect(out).toContain("4 inbound callers");
    expect(out).toContain("src/commands/run.ts:12");
    expect(out).toContain("src/commands/run.ts:34");
    expect(out).toContain("tests/baz.test.ts:7");
    expect(out).not.toContain("src/other.ts:100");
  });

  it("emits TSV row in --agent mode", async () => {
    defRow = {
      path: "/proj/src/lib/baz.ts",
      start_line: 87,
      is_exported: false,
    };
    getCallers.mockResolvedValueOnce([
      { symbol: "run", file: "/proj/src/commands/run.ts", line: 11 },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (dead as Command).parseAsync(["baz", "--agent"], { from: "user" });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toBe("LIVE\tsrc/lib/baz.ts:88\t1\tsrc/commands/run.ts:12");
  });

  it("emits TSV with empty callers column for DEAD --agent mode", async () => {
    defRow = {
      path: "/proj/src/util/foo.ts",
      start_line: 41,
      is_exported: false,
    };
    getCallers.mockResolvedValueOnce([]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (dead as Command).parseAsync(["foo", "--agent"], { from: "user" });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toBe("DEAD\tsrc/util/foo.ts:42\t0\t");
  });

  it("exits with code 1 when the symbol is not in the index", async () => {
    defRow = null;

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (dead as Command).parseAsync(["missing"], { from: "user" });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toContain("Symbol not found: missing");
    expect(process.exitCode).toBe(1);
  });
});
