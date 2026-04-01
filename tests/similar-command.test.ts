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

const mockVectorSearch = vi.fn();
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
        vectorSearch: mockVectorSearch,
      })),
      close: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

import { similar } from "../src/commands/similar";

describe("similar command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (similar as Command).exitOverride();
    // Reset mock chain
    mockQueryChain.toArray.mockResolvedValue([]);
    mockVectorSearch.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => []),
    });
  });

  it("reports symbol not found", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (similar as Command).parseAsync(["nonexistent"], { from: "user" });
    expect(spy).toHaveBeenCalledWith("Symbol not found: nonexistent");
    spy.mockRestore();
  });

  it("finds similar code for a symbol", async () => {
    // Source chunk lookup
    mockQueryChain.toArray.mockResolvedValueOnce([
      {
        vector: new Float32Array(384),
        path: "/tmp/project/src/auth.ts",
        defined_symbols: ["handleAuth"],
        start_line: 10,
      },
    ]);

    // Vector search results
    const vsChain = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => [
        {
          path: "/tmp/project/src/session.ts",
          start_line: 20,
          defined_symbols: ["handleSession"],
          role: "ORCHESTRATION",
          _distance: 0.15,
        },
      ]),
    };
    mockVectorSearch.mockReturnValue(vsChain);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (similar as Command).parseAsync(["handleAuth"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("similar to handleAuth");
    expect(output).toContain("src/session.ts");
    expect(output).toContain("handleSession");
    spy.mockRestore();
  });

  it("excludes the source chunk from results", async () => {
    mockQueryChain.toArray.mockResolvedValueOnce([
      {
        vector: new Float32Array(384),
        path: "/tmp/project/src/auth.ts",
        defined_symbols: ["handleAuth"],
        start_line: 10,
      },
    ]);

    const vsChain = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => [
        { path: "/tmp/project/src/auth.ts", start_line: 10, defined_symbols: ["handleAuth"], role: "ORCH", _distance: 0 },
      ]),
    };
    mockVectorSearch.mockReturnValue(vsChain);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (similar as Command).parseAsync(["handleAuth"], { from: "user" });
    expect(spy).toHaveBeenCalledWith("No similar code found for handleAuth.");
    spy.mockRestore();
  });

  it("uses agent format with --agent", async () => {
    mockQueryChain.toArray.mockResolvedValueOnce([
      { vector: new Float32Array(384), path: "/tmp/project/src/auth.ts", defined_symbols: ["handleAuth"], start_line: 10 },
    ]);
    const vsChain = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => [
        { path: "/tmp/project/src/session.ts", start_line: 20, defined_symbols: ["handleSession"], role: "ORCH", _distance: 0.1 },
      ]),
    };
    mockVectorSearch.mockReturnValue(vsChain);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (similar as Command).parseAsync(["handleAuth", "--agent"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("d=0.100");
    expect(output).not.toContain("similar to");
    spy.mockRestore();
  });
});
