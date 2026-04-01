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

const mockFindTests = vi.fn(async () => []);
const mockResolveTargetSymbols = vi.fn(async () => ({
  symbols: ["handleAuth"],
  resolvedAsFile: false,
}));

vi.mock("../src/lib/graph/impact", () => ({
  findTests: (...args: any[]) => mockFindTests(...args),
  resolveTargetSymbols: (...args: any[]) => mockResolveTargetSymbols(...args),
}));

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(function () {
    return { close: vi.fn(async () => {}) };
  }),
}));

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

import { testFind } from "../src/commands/test-find";

describe("test-find command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (testFind as Command).exitOverride();
  });

  it("reports no tests when none found", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth"], { from: "user" });
    expect(spy).toHaveBeenCalledWith("No tests found for handleAuth.");
    spy.mockRestore();
  });

  it("lists tests that call the symbol", async () => {
    mockFindTests.mockResolvedValueOnce([
      { file: "/tmp/project/tests/auth.test.ts", symbol: "testLogin", line: 10, hops: 0 },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("tests/auth.test.ts");
    expect(output).toContain("testLogin");
    expect(output).toContain("calls directly");
    spy.mockRestore();
  });

  it("reports multi-hop tests", async () => {
    mockFindTests.mockResolvedValueOnce([
      { file: "/tmp/project/tests/login.test.ts", symbol: "testLoginFlow", line: 20, hops: 1 },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("1 hop away");
    spy.mockRestore();
  });

  it("handles symbol not found", async () => {
    mockResolveTargetSymbols.mockResolvedValueOnce({
      symbols: [],
      resolvedAsFile: false,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["nonexistent"], { from: "user" });
    expect(spy).toHaveBeenCalledWith("Symbol not found: nonexistent");
    spy.mockRestore();
  });

  it("uses agent format with --agent", async () => {
    mockFindTests.mockResolvedValueOnce([
      { file: "/tmp/project/tests/auth.test.ts", symbol: "testLogin", line: 10, hops: 0 },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth", "--agent"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("direct");
    expect(output).not.toContain("Tests for");
    spy.mockRestore();
  });
});
