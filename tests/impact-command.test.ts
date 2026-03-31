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
const mockFindDependents = vi.fn(async () => []);
const mockResolveTargetSymbols = vi.fn(async () => ({
  symbols: ["handleAuth"],
  resolvedAsFile: false,
}));

vi.mock("../src/lib/graph/impact", () => ({
  findTests: (...args: any[]) => mockFindTests(...args),
  findDependents: (...args: any[]) => mockFindDependents(...args),
  resolveTargetSymbols: (...args: any[]) => mockResolveTargetSymbols(...args),
  isTestPath: (p: string) =>
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p) ||
    /(^|\/)(__tests__|tests?)(\/|$)/i.test(p),
}));

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(function () {
    return { close: vi.fn(async () => {}) };
  }),
}));

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

import { impact } from "../src/commands/impact";

describe("impact command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (impact as Command).exitOverride();
  });

  it("shows dependents and tests", async () => {
    mockFindDependents.mockResolvedValueOnce([
      { file: "/tmp/project/src/router.ts", sharedSymbols: 2 },
    ]);
    mockFindTests.mockResolvedValueOnce([
      { file: "/tmp/project/tests/auth.test.ts", symbol: "testAuth", line: 5, hops: 0 },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (impact as Command).parseAsync(["handleAuth"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Impact analysis");
    expect(output).toContain("src/router.ts");
    expect(output).toContain("2 shared symbols");
    expect(output).toContain("tests/auth.test.ts");
    spy.mockRestore();
  });

  it("reports no impact when empty", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (impact as Command).parseAsync(["handleAuth"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("none found");
    spy.mockRestore();
  });

  it("uses agent format with --agent", async () => {
    mockFindDependents.mockResolvedValueOnce([
      { file: "/tmp/project/src/router.ts", sharedSymbols: 1 },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (impact as Command).parseAsync(["handleAuth", "--agent"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("dep:");
    expect(output).not.toContain("Impact analysis");
    spy.mockRestore();
  });
});
