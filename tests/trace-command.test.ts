import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("trace --inbound", () => {
  beforeAll(() => {
    process.env.NO_COLOR = "1";
  });
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(out).toMatch(/src\/caller\.ts:3\thelper\tconst result = doWork\(arg\);/);
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

    const callerLines = out.split("\n").filter((l) => l.includes("caller.ts:3"));
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
    await (trace as Command).parseAsync(["doWork", "--inbound"], { from: "user" });
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
    await (trace as Command).parseAsync(["doWork", "--agent"], { from: "user" });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();

    // Existing trace agent format uses '<-' prefix
    expect(out).toMatch(/<-\s+helper/);
    // No call-site snippet column
    expect(out).not.toContain("const result = doWork(arg);");
  });
});
