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
const mockFindDependentsDetailed = vi.fn(async () => []);
const mockResolveTargetSymbols = vi.fn(async () => ({
  symbols: ["handleAuth"],
  resolvedAsFile: false,
}));

vi.mock("../src/lib/graph/impact", () => ({
  findTests: (...args: any[]) => mockFindTests(...args),
  findDependents: (...args: any[]) => mockFindDependents(...args),
  findDependentsDetailed: (...args: any[]) =>
    mockFindDependentsDetailed(...args),
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
      {
        file: "/tmp/project/tests/auth.test.ts",
        symbol: "testAuth",
        line: 5,
        hops: 0,
      },
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
    await (impact as Command).parseAsync(["handleAuth", "--agent"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("dep:");
    expect(output).not.toContain("Impact analysis");
    spy.mockRestore();
  });

  it("--no-tests skips the test traversal and omits the section", async () => {
    mockFindDependents.mockResolvedValueOnce([
      { file: "/tmp/project/src/router.ts", sharedSymbols: 2 },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (impact as Command).parseAsync(["handleAuth", "--no-tests"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");

    // findTests must not run, and the affected-tests section is omitted
    // entirely (not rendered as "none found").
    expect(mockFindTests).not.toHaveBeenCalled();
    expect(output).toContain("Direct dependents");
    expect(output).not.toContain("Affected tests");
    spy.mockRestore();
  });

  it("--no-tests in agent mode emits only dep lines", async () => {
    mockFindDependents.mockResolvedValueOnce([
      { file: "/tmp/project/src/router.ts", sharedSymbols: 1 },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (impact as Command).parseAsync(
      ["handleAuth", "--no-tests", "--agent"],
      {
        from: "user",
      },
    );
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(mockFindTests).not.toHaveBeenCalled();
    expect(output).toContain("dep:");
    expect(output).not.toContain("test:");
    spy.mockRestore();
  });

  it("uses rollup by default for file targets in human mode", async () => {
    mockResolveTargetSymbols.mockResolvedValueOnce({
      symbols: ["Foo", "Bar"],
      resolvedAsFile: true,
    });
    mockFindDependentsDetailed.mockResolvedValueOnce([
      {
        file: "/tmp/project/packages/app/src/use-foo.ts",
        sharedSymbols: 1,
        symbols: ["Foo"],
      },
      {
        file: "/tmp/project/packages/api/src/use-both.ts",
        sharedSymbols: 2,
        symbols: ["Foo", "Bar"],
      },
    ]);
    mockFindTests.mockResolvedValueOnce([
      {
        file: "/tmp/project/packages/app/src/foo.test.ts",
        symbol: "testFoo",
        line: 4,
        hops: 0,
      },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (impact as Command).parseAsync(["src/foo.ts"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");

    expect(mockFindDependentsDetailed).toHaveBeenCalled();
    expect(output).toContain("Impact rollup for src/foo.ts");
    expect(output).toContain("Exports: 2");
    expect(output).toContain("packages/app");
    expect(output).toContain("packages/api");
    expect(output).toContain("Affected tests: 1");
    spy.mockRestore();
  });

  it("--flat preserves legacy file-target output", async () => {
    mockResolveTargetSymbols.mockResolvedValueOnce({
      symbols: ["Foo"],
      resolvedAsFile: true,
    });
    mockFindDependents.mockResolvedValueOnce([
      { file: "/tmp/project/src/use-foo.ts", sharedSymbols: 1 },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (impact as Command).parseAsync(["src/foo.ts", "--flat"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");

    expect(mockFindDependents).toHaveBeenCalled();
    expect(mockFindDependentsDetailed).not.toHaveBeenCalled();
    expect(output).toContain("Direct dependents");
    expect(output).not.toContain("Impact rollup");
    spy.mockRestore();
  });

  it("--agent --rollup emits TSV rollup rows", async () => {
    mockFindDependentsDetailed.mockResolvedValueOnce([
      {
        file: "/tmp/project/packages/app/src/use-auth.ts",
        sharedSymbols: 1,
        symbols: ["handleAuth"],
      },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (impact as Command).parseAsync(
      ["handleAuth", "--agent", "--rollup"],
      {
        from: "user",
      },
    );
    const output = spy.mock.calls.map((c) => c[0]).join("\n");

    expect(output).toContain("summary\ttarget=handleAuth");
    expect(output).toContain("export\thandleAuth\tdeps=1");
    expect(output).toContain("pkg\tpackages/app");
    expect(output).not.toContain("dep:");
    spy.mockRestore();
  });

  it("--no-tests skips tests in rollup mode", async () => {
    mockResolveTargetSymbols.mockResolvedValueOnce({
      symbols: ["Foo"],
      resolvedAsFile: true,
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (impact as Command).parseAsync(["src/foo.ts", "--no-tests"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");

    expect(mockFindTests).not.toHaveBeenCalled();
    expect(output).toContain("Impact rollup");
    expect(output).not.toContain("Affected tests");
    spy.mockRestore();
  });
});
