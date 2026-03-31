import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/project-root", () => ({
  ensureProjectPaths: vi.fn(() => ({
    root: "/tmp/project",
    dataDir: "/tmp/.gmax",
    lancedbDir: "/tmp/.gmax/lancedb",
    cacheDir: "/tmp/.gmax/cache",
    lmdbPath: "/tmp/.gmax/cache/meta.lmdb",
    configPath: "/tmp/.gmax/config.json",
  })),
  findProjectRoot: vi.fn(() => "/tmp/project"),
}));

const mockSearcher = { search: vi.fn() };

vi.mock("../src/lib/search/searcher", () => ({
  Searcher: vi.fn(function () {
    return mockSearcher;
  }),
}));

const mockQueryChain = {
  select: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  toArray: vi.fn(async () => []),
};

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(function () {
    return {
      ensureTable: vi.fn(async () => ({
        query: vi.fn(() => mockQueryChain),
      })),
      close: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("../src/lib/skeleton", () => ({
  Skeletonizer: vi.fn(function () {
    return {
      init: vi.fn(async () => {}),
      isSupported: vi.fn(() => ({ supported: false })),
      skeletonizeFile: vi.fn(async () => ({ success: false })),
    };
  }),
}));

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...(actual as any),
    readFileSync: vi.fn(() => "function handleAuth() {\n  return true;\n}"),
  };
});

import { context } from "../src/commands/context";

describe("context command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (context as Command).exitOverride();
    mockSearcher.search.mockResolvedValue({ data: [] });
  });

  it("reports no results for empty search", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (context as Command).parseAsync(["auth system"], { from: "user" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("No results found"));
    spy.mockRestore();
  });

  it("generates context with entry points and budget", async () => {
    mockSearcher.search.mockResolvedValueOnce({
      data: [
        {
          path: "/tmp/project/src/auth.ts",
          start_line: 0,
          end_line: 2,
          defined_symbols: ["handleAuth"],
          role: "ORCHESTRATION",
          score: 0.9,
          metadata: { path: "/tmp/project/src/auth.ts" },
        },
      ],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (context as Command).parseAsync(["auth system", "--budget", "4000"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain('Context: "auth system"');
    expect(output).toContain("Entry Points");
    expect(output).toContain("handleAuth");
    expect(output).toContain("tokens used");
    spy.mockRestore();
  });
});
