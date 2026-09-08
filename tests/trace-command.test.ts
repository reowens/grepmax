import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Real project root with a temp dir + real source file so the snippet
// reader (sync fs.readFileSync) finds something believable. Mocks the
// graph builder so we control the call topology exactly.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-trace-test-"));
const callerFile = path.join(tmpRoot, "src/caller.ts");
fs.mkdirSync(path.dirname(callerFile), { recursive: true });
fs.writeFileSync(
  callerFile,
  [
    "function helper() {",
    "  // pre-amble",
    "  const result = doWork(arg);",
    "  return result;",
    "}",
  ].join("\n"),
);

// Whether the project looks registered decides whether `trace` tries the
// daemon at all: an unregistered root has no chunks in the shared table.
let registered = false;
const sendDaemonCommand = vi.fn();

vi.mock("../src/lib/utils/daemon-client", () => ({
  sendDaemonCommand: (...args: unknown[]) => sendDaemonCommand(...args),
}));

vi.mock("../src/lib/utils/project-registry", () => ({
  resolveRootOrExit: (arg?: string) => arg ?? tmpRoot,
  getProject: (root: string) =>
    registered ? { root, name: "project", status: "indexed" } : undefined,
  listProjects: () =>
    registered ? [{ root: tmpRoot, status: "indexed" }] : [],
}));

vi.mock("../src/lib/utils/project-root", () => ({
  ensureProjectPaths: vi.fn(() => ({
    root: tmpRoot,
    dataDir: `${tmpRoot}/.gmax`,
    lancedbDir: `${tmpRoot}/.gmax/lancedb`,
    cacheDir: `${tmpRoot}/.gmax/cache`,
    lmdbPath: `${tmpRoot}/.gmax/cache/meta.lmdb`,
    configPath: `${tmpRoot}/.gmax/config.json`,
  })),
  findProjectRoot: vi.fn(() => tmpRoot),
}));

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(function () {
    return { close: vi.fn(async () => {}) };
  }),
}));

const buildGraphMultiHop = vi.fn();
vi.mock("../src/lib/graph/graph-builder", () => ({
  GraphBuilder: vi.fn(function () {
    return { buildGraphMultiHop };
  }),
}));

import { trace } from "../src/commands/trace";

// File-scope cleanup: the snippet reader needs the temp source file for every
// describe below, so it outlives the first one.
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("trace --inbound", () => {
  beforeAll(() => {
    process.env.NO_COLOR = "1";
  });
  beforeEach(() => {
    vi.clearAllMocks();
    registered = false;
    process.exitCode = undefined;
    (trace as Command).exitOverride();
  });

  it("emits center + caller rows with call-site snippets", async () => {
    buildGraphMultiHop.mockResolvedValueOnce({
      center: {
        symbol: "doWork",
        file: `${tmpRoot}/src/lib.ts`,
        line: 0,
        role: "DEFINITION",
      },
      callerTree: [
        {
          node: {
            symbol: "helper",
            file: callerFile,
            line: 0,
            role: "IMPLEMENTATION",
          },
          callers: [],
        },
      ],
      callees: [],
      importers: [],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork", "--inbound", "--agent"], {
      from: "user",
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toContain("doWork\tsrc/lib.ts:1\tDEFINITION");
    // snippet line found inside the caller's chunk window
    expect(out).toMatch(
      /src\/caller\.ts:3\thelper\tconst result = doWork\(arg\);/,
    );
  });

  it("--no-snippets drops the snippet column", async () => {
    buildGraphMultiHop.mockResolvedValueOnce({
      center: {
        symbol: "doWork",
        file: `${tmpRoot}/src/lib.ts`,
        line: 0,
        role: "DEFINITION",
      },
      callerTree: [
        {
          node: {
            symbol: "helper",
            file: callerFile,
            line: 0,
            role: "IMPLEMENTATION",
          },
          callers: [],
        },
      ],
      callees: [],
      importers: [],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(
      ["doWork", "--inbound", "--no-snippets", "--agent"],
      { from: "user" },
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    // 2-column row: file:line\tsymbol — no third column
    expect(out).toMatch(/src\/caller\.ts:1\thelper$/m);
    expect(out).not.toContain("doWork(arg)");
  });

  it("dedupes callers that resolve to the same call-site line", async () => {
    buildGraphMultiHop.mockResolvedValueOnce({
      center: {
        symbol: "doWork",
        file: `${tmpRoot}/src/lib.ts`,
        line: 0,
        role: "DEFINITION",
      },
      callerTree: [
        {
          node: {
            symbol: "helper",
            file: callerFile,
            line: 0,
            role: "IMPLEMENTATION",
          },
          callers: [],
        },
        // Second chunk of the same file pointing at the same call site
        {
          node: {
            symbol: "helperAlias",
            file: callerFile,
            line: 0,
            role: "IMPLEMENTATION",
          },
          callers: [],
        },
      ],
      callees: [],
      importers: [],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork", "--inbound", "--agent"], {
      from: "user",
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    const callerLines = out
      .split("\n")
      .filter((l) => l.includes("caller.ts:3"));
    expect(callerLines).toHaveLength(1);
  });

  it("renders human mode with bold header and tree", async () => {
    buildGraphMultiHop.mockResolvedValueOnce({
      center: {
        symbol: "doWork",
        file: `${tmpRoot}/src/lib.ts`,
        line: 0,
        role: "DEFINITION",
      },
      callerTree: [
        {
          node: {
            symbol: "helper",
            file: callerFile,
            line: 0,
            role: "IMPLEMENTATION",
          },
          callers: [],
        },
      ],
      callees: [],
      importers: [],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork", "--inbound"], {
      from: "user",
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toContain("inbound callers of doWork");
    expect(out).toContain("helper");
    expect(out).toContain("src/caller.ts:3");
    expect(out).toContain("const result = doWork(arg);");
  });

  it("does not affect default trace output (regression)", async () => {
    buildGraphMultiHop.mockResolvedValueOnce({
      center: {
        symbol: "doWork",
        file: `${tmpRoot}/src/lib.ts`,
        line: 0,
        role: "DEFINITION",
      },
      callerTree: [
        {
          node: {
            symbol: "helper",
            file: callerFile,
            line: 0,
            role: "IMPLEMENTATION",
          },
          callers: [],
        },
      ],
      callees: [],
      importers: [],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork", "--agent"], {
      from: "user",
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    // Existing trace agent format uses '<-' prefix
    expect(out).toMatch(/<-\s+helper/);
    // No call-site snippet column
    expect(out).not.toContain("const result = doWork(arg);");
  });

  it("collapses repeated caller symbols into one row in --agent", async () => {
    buildGraphMultiHop.mockResolvedValueOnce({
      center: {
        symbol: "doWork",
        file: `${tmpRoot}/src/lib.ts`,
        line: 0,
        role: "DEFINITION",
      },
      callerTree: [
        {
          node: { symbol: "runSearch", file: callerFile, line: 0 },
          callers: [],
        },
        {
          node: { symbol: "runSearch", file: callerFile, line: 2 },
          callers: [],
        },
      ],
      callees: [],
      importers: [],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork", "--agent"], {
      from: "user",
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    const runSearchLines = out
      .split("\n")
      .filter((l) => l.includes("<- runSearch"));
    expect(runSearchLines).toHaveLength(1);
    expect(runSearchLines[0]).toContain("src/caller.ts:0,2");
  });

  it("suppresses self-edges in --agent", async () => {
    buildGraphMultiHop.mockResolvedValueOnce({
      center: {
        symbol: "doWork",
        file: `${tmpRoot}/src/lib.ts`,
        line: 0,
        role: "DEFINITION",
      },
      callerTree: [
        // Self-edge: the traced symbol referencing itself — should be hidden.
        {
          node: { symbol: "doWork", file: `${tmpRoot}/src/lib.ts`, line: 0 },
          callers: [],
        },
        { node: { symbol: "helper", file: callerFile, line: 0 }, callers: [] },
      ],
      callees: [],
      importers: [],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork", "--agent"], {
      from: "user",
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toMatch(/<-\s+helper/);
    expect(out).not.toMatch(/<-\s+doWork/);
  });

  it("--raw lists every call-site and keeps self-edges", async () => {
    buildGraphMultiHop.mockResolvedValueOnce({
      center: {
        symbol: "doWork",
        file: `${tmpRoot}/src/lib.ts`,
        line: 0,
        role: "DEFINITION",
      },
      callerTree: [
        {
          node: { symbol: "runSearch", file: callerFile, line: 0 },
          callers: [],
        },
        {
          node: { symbol: "runSearch", file: callerFile, line: 2 },
          callers: [],
        },
        {
          node: { symbol: "doWork", file: `${tmpRoot}/src/lib.ts`, line: 0 },
          callers: [],
        },
      ],
      callees: [],
      importers: [],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork", "--agent", "--raw"], {
      from: "user",
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    // Not collapsed: both call-sites listed separately.
    const runSearchLines = out
      .split("\n")
      .filter((l) => l.includes("<- runSearch"));
    expect(runSearchLines).toHaveLength(2);
    // Self-edge retained under --raw.
    expect(out).toMatch(/<-\s+doWork/);
  });
});

/**
 * `trace` as a thin IPC client: the daemon builds the graph, this process only
 * reads call-site snippets out of the working tree and renders.
 */
describe("trace store access", () => {
  const GRAPH = {
    center: {
      symbol: "doWork",
      file: `${tmpRoot}/src/lib.ts`,
      line: 0,
      role: "DEFINITION",
    },
    callerTree: [
      {
        node: {
          symbol: "helper",
          file: callerFile,
          line: 0,
          role: "IMPLEMENTATION",
        },
        callers: [],
      },
    ],
    callees: [],
    importers: [],
  };

  beforeAll(() => {
    process.env.NO_COLOR = "1";
    process.env.GMAX_NO_STALE_HINT = "1";
  });

  beforeEach(() => {
    vi.clearAllMocks();
    registered = true;
    process.exitCode = undefined;
    (trace as Command).exitOverride();
  });

  it("renders the daemon's graph without building one locally", async () => {
    sendDaemonCommand.mockResolvedValue({ ok: true, graph: GRAPH });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork", "--agent"], {
      from: "user",
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toMatch(/<-\s+helper/);
    expect(sendDaemonCommand.mock.calls[0][0]).toMatchObject({
      cmd: "graph.trace",
      projectRoot: tmpRoot,
      target: "doWork",
      hops: 1,
    });
    expect(buildGraphMultiHop).not.toHaveBeenCalled();
  });

  it("still reads call-site snippets locally under --inbound", async () => {
    sendDaemonCommand.mockResolvedValue({ ok: true, graph: GRAPH });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork", "--inbound", "--agent"], {
      from: "user",
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toMatch(
      /src\/caller\.ts:3\thelper\tconst result = doWork\(arg\);/,
    );
  });

  it("falls back in-process only when nothing is listening", async () => {
    sendDaemonCommand.mockResolvedValue({ ok: false, error: "ENOENT" });
    buildGraphMultiHop.mockResolvedValueOnce(GRAPH);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork", "--agent"], {
      from: "user",
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    expect(out).toMatch(/<-\s+helper/);
    expect(buildGraphMultiHop).toHaveBeenCalledOnce();
  });

  it("refuses with the socket hint when the sandbox blocks the socket", async () => {
    sendDaemonCommand.mockResolvedValue({ ok: false, error: "EPERM" });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork"], { from: "user" });
    const errors = errSpy.mock.calls.map((c) => String(c[0]));
    errSpy.mockRestore();
    logSpy.mockRestore();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("allowUnixSockets");
    expect(errors[0]).not.toContain("Trace failed");
    expect(process.exitCode).toBe(2);
    // The refusal must not turn into an in-process store read.
    expect(buildGraphMultiHop).not.toHaveBeenCalled();
  });

  it("reports a live-daemon error without falling back", async () => {
    sendDaemonCommand.mockResolvedValue({ ok: false, error: "DAEMON_BUSY" });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await (trace as Command).parseAsync(["doWork"], { from: "user" });
    const errors = errSpy.mock.calls.map((c) => c.join(" "));
    errSpy.mockRestore();

    expect(errors.join("\n")).toContain("Trace failed");
    expect(errors.join("\n")).toContain("DAEMON_BUSY");
    expect(process.exitCode).toBe(1);
    expect(buildGraphMultiHop).not.toHaveBeenCalled();
  });
});
