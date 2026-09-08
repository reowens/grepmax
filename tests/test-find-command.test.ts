import type { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Whether the project looks registered decides whether `test` even tries the
// daemon: an unregistered root has no chunks in the shared table, so the client
// skips the socket rather than turning an empty answer into a daemon error.
let registered = false;
const sendDaemonCommand = vi.fn();

vi.mock("../src/lib/utils/daemon-client", () => ({
  sendDaemonCommand: (...args: unknown[]) => sendDaemonCommand(...args),
}));

vi.mock("../src/lib/utils/project-registry", () => ({
  resolveRootOrExit: (arg?: string) => arg ?? "/tmp/project",
  getProject: (root: string) =>
    registered ? { root, name: "project", status: "indexed" } : undefined,
  listProjects: () =>
    registered ? [{ root: "/tmp/project", status: "indexed" }] : [],
}));

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

const mockFindTests: any = vi.fn(async () => [] as any[]);
const mockResolveTargetSymbols: any = vi.fn(async () => ({
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
    registered = false;
    process.exitCode = undefined;
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
      {
        file: "/tmp/project/tests/auth.test.ts",
        symbol: "testLogin",
        line: 10,
        hops: 0,
      },
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
      {
        file: "/tmp/project/tests/login.test.ts",
        symbol: "testLoginFlow",
        line: 20,
        hops: 1,
      },
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
      {
        file: "/tmp/project/tests/auth.test.ts",
        symbol: "testLogin",
        line: 10,
        hops: 0,
      },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth", "--agent"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("direct");
    expect(output).not.toContain("Tests for");
    spy.mockRestore();
  });

  it("renders via-import label for hops=-1 fallback hits", async () => {
    mockFindTests.mockResolvedValueOnce([
      {
        file: "/tmp/project/tests/auth.test.ts",
        symbol: "(referenced)",
        line: 0,
        hops: -1,
      },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth", "--agent"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("via-import");
    expect(output).toContain("tests/auth.test.ts");
    spy.mockRestore();
  });

  it("renders 'via import' label in human mode", async () => {
    mockFindTests.mockResolvedValueOnce([
      {
        file: "/tmp/project/tests/auth.test.ts",
        symbol: "(referenced)",
        line: 0,
        hops: -1,
      },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("(via import)");
    spy.mockRestore();
  });
});

/**
 * The store-access policy, exercised through the command. The daemon owns the
 * store while it is up; the in-process path is for "no daemon exists" only, and
 * a sandbox denial must produce one actionable line instead of a stack.
 */
describe("test-find store access", () => {
  const TEST_HIT = {
    file: "/tmp/project/tests/auth.test.ts",
    symbol: "testLogin",
    line: 10,
    hops: 0,
  };

  beforeAll(() => {
    // maybeWarnStale* reads the registry once the project looks registered;
    // its stderr nudge is not what these tests are about.
    process.env.GMAX_NO_STALE_HINT = "1";
  });

  beforeEach(() => {
    vi.clearAllMocks();
    registered = true;
    process.exitCode = undefined;
    (testFind as Command).exitOverride();
  });

  it("asks the daemon and never opens the store itself", async () => {
    sendDaemonCommand.mockImplementation(async (cmd: any) =>
      cmd.cmd === "graph.resolve"
        ? { ok: true, symbols: ["handleAuth"], resolvedAsFile: false }
        : { ok: true, hits: [TEST_HIT] },
    );

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth", "--agent"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    spy.mockRestore();

    expect(output).toContain("tests/auth.test.ts:11");
    expect(sendDaemonCommand.mock.calls.map((c) => c[0].cmd)).toEqual([
      "graph.resolve",
      "graph.tests",
    ]);
    // The library functions run daemon-side, not here.
    expect(mockResolveTargetSymbols).not.toHaveBeenCalled();
    expect(mockFindTests).not.toHaveBeenCalled();
  });

  it("sends the resolved scope so the daemon can re-validate it", async () => {
    sendDaemonCommand.mockResolvedValue({
      ok: true,
      symbols: ["handleAuth"],
      resolvedAsFile: false,
      hits: [],
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(
      ["handleAuth", "--exclude", "vendor"],
      { from: "user" },
    );
    spy.mockRestore();

    expect(sendDaemonCommand.mock.calls[0][0]).toMatchObject({
      projectRoot: "/tmp/project",
      excludePrefixes: ["/tmp/project/vendor/"],
    });
  });

  it("falls back in-process only when nothing is listening", async () => {
    sendDaemonCommand.mockResolvedValue({ ok: false, error: "ENOENT" });
    mockFindTests.mockResolvedValueOnce([TEST_HIT]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth", "--agent"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    spy.mockRestore();

    expect(output).toContain("tests/auth.test.ts:11");
    expect(mockResolveTargetSymbols).toHaveBeenCalled();
    expect(mockFindTests).toHaveBeenCalled();
  });

  it("falls back in-process for a daemon too old to know the verb", async () => {
    sendDaemonCommand.mockResolvedValue({
      ok: false,
      error: "unknown command: graph.resolve",
    });
    mockFindTests.mockResolvedValueOnce([TEST_HIT]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth", "--agent"], {
      from: "user",
    });
    spy.mockRestore();

    expect(mockFindTests).toHaveBeenCalled();
  });

  it("refuses with the socket hint when the sandbox blocks the socket", async () => {
    sendDaemonCommand.mockResolvedValue({ ok: false, error: "EPERM" });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth"], { from: "user" });
    const errors = errSpy.mock.calls.map((c) => String(c[0]));
    errSpy.mockRestore();
    logSpy.mockRestore();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("allowUnixSockets");
    expect(errors[0]).not.toContain("Test find failed");
    expect(process.exitCode).toBe(2);
    // Refusing means refusing: no in-process store read behind the denial.
    expect(mockResolveTargetSymbols).not.toHaveBeenCalled();
  });

  it("reports a live-daemon error without falling back", async () => {
    sendDaemonCommand.mockResolvedValue({ ok: false, error: "DAEMON_BUSY" });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth"], { from: "user" });
    const errors = errSpy.mock.calls.map((c) => c.join(" "));
    errSpy.mockRestore();

    expect(errors.join("\n")).toContain("Test find failed");
    expect(errors.join("\n")).toContain("DAEMON_BUSY");
    expect(process.exitCode).toBe(1);
    expect(mockResolveTargetSymbols).not.toHaveBeenCalled();
  });

  it("skips the daemon entirely for an unregistered project", async () => {
    registered = false;
    mockFindTests.mockResolvedValueOnce([TEST_HIT]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (testFind as Command).parseAsync(["handleAuth", "--agent"], {
      from: "user",
    });
    spy.mockRestore();

    expect(sendDaemonCommand).not.toHaveBeenCalled();
    expect(mockFindTests).toHaveBeenCalled();
  });
});
