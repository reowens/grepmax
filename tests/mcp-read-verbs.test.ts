/**
 * WP-D: every MCP read tool goes through the daemon's read verbs.
 *
 * The MCP server is started in-process with the SDK stubbed so each registered
 * tool handler can be called directly, and `sendDaemonCommand` is a mock that
 * answers one canned verb response per tool. Two things are asserted:
 *
 *   1. Each tool sends the verb it is supposed to send, and renders the
 *      daemon's answer — without constructing a VectorDB. `vectorDbCtor` is the
 *      tripwire: an MCP session must hold no store of its own while a daemon
 *      serving the verbs is up.
 *   2. The in-process fallback is entered for exactly the three reasons MCP
 *      allows (nothing listening, a daemon too old for the verb, an oversize
 *      response) and never for a live daemon saying no.
 *
 * Note the live daemon cannot exercise any of this: 0.26.27 does not know the
 * read verbs, so a real socket would answer `unknown command` and every call
 * would take the fallback. The daemon side is covered by the handler unit tests
 * and the fake-Daemon dispatch tests instead.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

const tools = new Map<string, ToolHandler>();
const sendDaemonCommand = vi.fn();
const vectorDbCtor = vi.fn();

let projectRoot: string;
let sourceFile: string;

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    }
    async connect() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

vi.mock("../src/lib/utils/daemon-client", () => ({
  sendDaemonCommand: (...args: unknown[]) => sendDaemonCommand(...args),
  ensureDaemonRunning: vi.fn(async () => false),
  isDaemonRunning: vi.fn(async () => false),
}));

vi.mock("../src/lib/utils/project-root", () => ({
  findProjectRoot: () => projectRoot,
  ensureProjectPaths: () => ({
    root: projectRoot,
    dataDir: path.join(projectRoot, ".gmax"),
    lancedbDir: path.join(projectRoot, ".gmax/lancedb"),
    cacheDir: path.join(projectRoot, ".gmax/cache"),
    lmdbPath: path.join(projectRoot, ".gmax/cache/meta.lmdb"),
    configPath: path.join(projectRoot, ".gmax/config.json"),
  }),
}));

vi.mock("../src/lib/utils/project-registry", () => ({
  listProjects: () => [
    {
      root: projectRoot,
      name: "project",
      status: "indexed",
      chunkCount: 12,
      lastIndexed: "2026-09-08",
    },
  ],
  getProject: (root: string) =>
    root === projectRoot
      ? { root, name: "project", status: "indexed" }
      : undefined,
}));

// Constructing this is the observable proof that the in-process path ran.
vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: class {
    constructor(...args: unknown[]) {
      vectorDbCtor(...args);
    }
    async ensureTable() {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.where = () => chain;
      chain.limit = () => chain;
      chain.toArray = async () => [];
      return {
        query: () => chain,
        search: () => chain,
        vectorSearch: () => chain,
      };
    }
    async countRowsForPath() {
      return 0;
    }
    async countDistinctFilesForPath() {
      return 0;
    }
    async close() {}
  },
}));

vi.mock("../src/lib/utils/watcher-launcher", () => ({
  launchWatcher: vi.fn(async () => ({ ok: true, reused: true })),
}));

vi.mock("../src/lib/utils/watcher-store", () => ({
  getWatcherCoveringPath: () => undefined,
}));

vi.mock("../src/lib/index/index-config", () => ({
  readGlobalConfig: () => ({
    embedMode: "mlx",
    modelTier: "small",
    vectorDim: 384,
  }),
}));

vi.mock("../src/lib/index/embedding-status", () => ({
  assertEmbeddingSearchCompatible: () => {},
  embeddingFingerprintLabel: () => "fp",
  projectEmbeddingStatus: () => ({
    state: "current",
    configured: { tier: "small", vectorDim: 384, fingerprint: "fp" },
    built: null,
  }),
}));

vi.mock("../src/lib/skeleton/skeletonizer", () => ({
  Skeletonizer: class {
    async init() {}
    async skeletonizeFile() {
      return {
        success: true,
        skeleton: "// generated locally",
        tokenEstimate: 4,
        language: "ts",
      };
    }
  },
}));

// review_risk and diff_changes keep their git half client-side; stub it so the
// store half is what these tests exercise.
vi.mock("../src/lib/llm/diff", () => ({
  extractDiff: () => "@@ handleAuth @@",
  extractSymbols: () => ["handleAuth"],
  fileChurn: () => 3,
}));

vi.mock("../src/lib/utils/git", () => ({
  getChangedFiles: () => [sourceFile],
}));

import { mcp } from "../src/commands/mcp";

const originalConsole = { log: console.log, error: console.error };

async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const handler = tools.get(name);
  if (!handler) throw new Error(`tool not registered: ${name}`);
  const result = await handler(args);
  return result.content?.[0]?.text ?? "";
}

async function callRaw(name: string, args: Record<string, unknown> = {}) {
  const handler = tools.get(name);
  if (!handler) throw new Error(`tool not registered: ${name}`);
  return handler(args);
}

/** The single verb each canned answer is for, in call order. */
function respond(answers: Record<string, unknown>): void {
  sendDaemonCommand.mockImplementation(async (cmd: Record<string, unknown>) => {
    const answer = answers[String(cmd.cmd)];
    if (!answer) return { ok: false, error: `unexpected verb ${cmd.cmd}` };
    return answer;
  });
}

const CENTER = {
  symbol: "handleAuth",
  file: "",
  line: 9,
  role: "IMPLEMENTATION",
  calls: [],
  calledBy: [],
};

beforeAll(async () => {
  projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "gmax-mcp-verbs-")),
  );
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  sourceFile = path.join(projectRoot, "src/auth.ts");
  fs.writeFileSync(
    sourceFile,
    "export function handleAuth() {\n  return 1;\n}\n",
  );
  CENTER.file = sourceFile;

  // The action registers its tools and then connects to the stubbed transport;
  // process.exit is stubbed because the server wires stdin close to it.
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  await (mcp as { parseAsync: (a: string[]) => Promise<unknown> }).parseAsync([
    "node",
    "gmax",
  ]);
});

afterAll(() => {
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  sendDaemonCommand.mockReset();
  vectorDbCtor.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MCP read tools go through the daemon read verbs", () => {
  it("semantic_search renders the daemon's search answer", async () => {
    respond({
      search: {
        ok: true,
        data: [
          {
            path: sourceFile,
            metadata: { path: sourceFile },
            generated_metadata: { start_line: 0, end_line: 2 },
            defined_symbols: ["handleAuth"],
            role: "IMPLEMENTATION",
          },
        ],
      },
    });
    const text = await call("semantic_search", { query: "auth handling" });
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("search");
    expect(text).toContain("src/auth.ts");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("code_skeleton reads the stored skeleton over rows.skeleton", async () => {
    respond({
      "rows.skeleton": {
        ok: true,
        path: sourceFile,
        skeleton: "export function handleAuth()",
      },
    });
    const text = await call("code_skeleton", { target: "src/auth.ts" });
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("rows.skeleton");
    expect(text).toContain("export function handleAuth()");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("trace_calls renders graph.trace", async () => {
    respond({
      "graph.trace": {
        ok: true,
        graph: {
          center: CENTER,
          callerTree: [
            { node: { ...CENTER, symbol: "startServer" }, callers: [] },
          ],
          callees: [],
          importers: [],
        },
      },
    });
    const text = await call("trace_calls", { symbol: "handleAuth" });
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("graph.trace");
    expect(text).toContain("Callers:");
    expect(text).toContain("startServer");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("extract_symbol locates the chunk over rows.locate and reads the body here", async () => {
    respond({
      "rows.locate": {
        ok: true,
        rows: [
          [
            {
              path: sourceFile,
              start_line: 0,
              end_line: 2,
              role: "IMPLEMENTATION",
              is_exported: true,
              defined_symbols: ["handleAuth"],
            },
          ],
        ],
      },
    });
    const text = await call("extract_symbol", { symbol: "handleAuth" });
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("rows.locate");
    expect(text).toContain("src/auth.ts:1-3");
    expect(text).toContain("export function handleAuth()");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("peek_symbol renders graph.peek's composite answer", async () => {
    respond({
      "graph.peek": {
        ok: true,
        peek: {
          defChunks: [{ path: sourceFile, startLine: 0 }],
          graph: { center: CENTER, callers: [], callees: [] },
          meta: { isExported: true, startLine: 0, endLine: 2 },
          callerTree: null,
          footerTests: null,
        },
      },
    });
    const text = await call("peek_symbol", { symbol: "handleAuth" });
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("graph.peek");
    expect(text).toContain("handleAuth");
    expect(text).toContain(", exported]");
    expect(text).toContain("No known callers.");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("dead renders graph.dead's facts", async () => {
    respond({
      "graph.dead": {
        ok: true,
        dead: {
          found: true,
          defPath: sourceFile,
          defLine: 9,
          isExported: false,
          callerCount: 0,
          topCallers: [],
        },
      },
    });
    const text = await call("dead", { symbol: "handleAuth" });
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("graph.dead");
    expect(text).toContain("DEAD  src/auth.ts:10 defines handleAuth");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("audit renders the finished graph.audit report", async () => {
    respond({
      "graph.audit": {
        ok: true,
        audit: {
          scannedChunks: 12,
          scannedFiles: 3,
          godNodes: [
            {
              symbol: "handleAuth",
              file: "src/auth.ts",
              line: 9,
              inboundFiles: 2,
              totalRefs: 4,
              defFiles: 1,
            },
          ],
          hubFiles: [],
          fileCycles: [],
          deadCandidates: [],
          deadTotal: 0,
        },
      },
    });
    const text = await call("audit", {});
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("graph.audit");
    expect(text).toContain("Audit — 12 chunks across 3 files");
    expect(text).toContain("handleAuth — 2 files, 4 refs (src/auth.ts:10)");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("audit reports an empty scope from a null report", async () => {
    respond({ "graph.audit": { ok: true, audit: null } });
    const text = await call("audit", {});
    expect(text).toContain("No indexed data found for");
  });

  it("surprising_connections renders vector.surprises", async () => {
    respond({
      "vector.surprises": {
        ok: true,
        summary: {
          sampledAnchors: 3,
          codeRows: 4,
          acceptedPairs: 0,
          acceptedFilePairs: 0,
          actionabilityScore: { p90: 0 },
          options: { dirDepth: 3 },
        },
        findings: [],
      },
    });
    const text = await call("surprising_connections", { experimental: true });
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("vector.surprises");
    expect(text).toContain("sampled=3");
    expect(text).toContain("none");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("get_neighbors renders graph.neighbors", async () => {
    respond({
      "graph.neighbors": {
        ok: true,
        hits: [{ symbol: "startServer", hops: 1, file: sourceFile, line: 4 }],
      },
    });
    const text = await call("get_neighbors", {
      symbol: "handleAuth",
      direction: "callers",
    });
    expect(sendDaemonCommand.mock.calls[0][0]).toMatchObject({
      cmd: "graph.neighbors",
      symbol: "handleAuth",
      direction: "callers",
    });
    expect(text).toContain("[1h] startServer src/auth.ts:5");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("find_paths renders graph.paths, including 'no path'", async () => {
    respond({ "graph.paths": { ok: true, path: ["a", "b", "c"] } });
    expect(await call("find_paths", { from: "a", to: "c" })).toContain(
      "Path (2 hops): a → b → c",
    );
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("graph.paths");

    respond({ "graph.paths": { ok: true, path: null } });
    expect(await call("find_paths", { from: "a", to: "z" })).toContain(
      "No callees path from 'a' to 'z'",
    );
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("subgraph_for_files renders graph.subgraph", async () => {
    respond({
      "graph.subgraph": {
        ok: true,
        subgraph: {
          files: [sourceFile],
          symbols: ["handleAuth"],
          internalEdges: [],
          externalDeps: ["fetch"],
        },
      },
    });
    const text = await call("subgraph_for_files", { files: ["src/auth.ts"] });
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("graph.subgraph");
    expect(text).toContain("1 file(s): 1 symbols");
    expect(text).toContain("External deps: fetch");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("list_symbols renders rows.symbols, with role and export tags", async () => {
    respond({
      "rows.symbols": {
        ok: true,
        entries: [
          {
            symbol: "handleAuth",
            count: 2,
            path: sourceFile,
            line: 9,
            role: "IMPLEMENTATION",
            exported: true,
          },
        ],
      },
    });
    const text = await call("list_symbols", {});
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("rows.symbols");
    expect(text).toBe("handleAuth [IMPL] exported\tsrc/auth.ts:10");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("index_status sums project-stats instead of scanning the table", async () => {
    respond({ "project-stats": { ok: true, chunks: 120, files: 8 } });
    const text = await call("index_status", {});
    expect(sendDaemonCommand.mock.calls[0][0]).toMatchObject({
      cmd: "project-stats",
      root: projectRoot,
    });
    expect(text).toContain("(120 chunks, 8 files)");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("summarize_directory answers from the decommissioned stub without a store", async () => {
    respond({});
    const text = await call("summarize_directory", {});
    expect(text).toContain("No chunks to summarize");
    expect(sendDaemonCommand).not.toHaveBeenCalled();
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("summarize_project renders the rows.project overview", async () => {
    respond({
      "rows.project": {
        ok: true,
        overview: {
          chunks: 100,
          files: 20,
          extEntries: [[".ts", 100]],
          dirEntries: [["src/", { files: 20, chunks: 100 }]],
          roleEntries: [["IMPLEMENTATION", 100]],
          topSymbols: [["handleAuth", 7]],
          entryPoints: [{ symbol: "main", path: "src/index.ts" }],
        },
      },
    });
    const text = await call("summarize_project", {});
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("rows.project");
    expect(text).toContain("100 chunks • 20 files");
    expect(text).toContain("Languages: .ts (100%)");
    expect(text).toContain("Roles: 100% IMPLEMENTATION");
    expect(text).toContain("handleAuth");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("related_files batches its selects into rows.locate", async () => {
    const other = path.join(projectRoot, "src/server.ts");
    let round = 0;
    sendDaemonCommand.mockImplementation(
      async (cmd: Record<string, unknown>) => {
        expect(cmd.cmd).toBe("rows.locate");
        round += 1;
        if (round === 1) {
          return {
            ok: true,
            rows: [
              [
                {
                  defined_symbols: ["handleAuth"],
                  referenced_symbols: ["startServer"],
                },
              ],
            ],
          };
        }
        return { ok: true, rows: [[{ path: other }]] };
      },
    );
    const text = await call("related_files", { file: "src/auth.ts" });
    expect(text).toContain("Dependencies (files this imports/calls):");
    expect(text).toContain("src/server.ts");
    expect(text).toContain("Dependents (files that call this):");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("find_tests resolves then asks graph.tests", async () => {
    respond({
      "graph.resolve": {
        ok: true,
        symbols: ["handleAuth"],
        resolvedAsFile: false,
        symbolFamilies: null,
      },
      "graph.tests": {
        ok: true,
        hits: [
          {
            file: path.join(projectRoot, "tests/auth.test.ts"),
            line: 4,
            symbol: "testLogin",
            hops: 0,
          },
        ],
      },
    });
    const text = await call("find_tests", { target: "handleAuth" });
    expect(sendDaemonCommand.mock.calls.map((c) => c[0].cmd)).toEqual([
      "graph.resolve",
      "graph.tests",
    ]);
    expect(text).toContain("tests/auth.test.ts:5 testLogin (direct)");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("impact_analysis asks graph.resolve, graph.dependents and graph.tests", async () => {
    respond({
      "graph.resolve": {
        ok: true,
        symbols: ["handleAuth"],
        resolvedAsFile: false,
        symbolFamilies: null,
      },
      "graph.dependents": {
        ok: true,
        dependents: [
          { file: path.join(projectRoot, "src/server.ts"), sharedSymbols: 2 },
        ],
      },
      "graph.tests": { ok: true, hits: [] },
    });
    const text = await call("impact_analysis", { target: "handleAuth" });
    expect(new Set(sendDaemonCommand.mock.calls.map((c) => c[0].cmd))).toEqual(
      new Set(["graph.resolve", "graph.dependents", "graph.tests"]),
    );
    expect(text).toContain("Dependents (1):");
    expect(text).toContain("src/server.ts (2 shared)");
    expect(text).toContain("Affected tests: none found");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("find_similar renders vector.similar's ranked chunks", async () => {
    respond({
      "vector.similar": {
        ok: true,
        status: "ok",
        results: [
          {
            path: path.join(projectRoot, "src/server.ts"),
            start_line: 4,
            end_line: 9,
            defined_symbols: ["startServer"],
            role: "IMPLEMENTATION",
            _distance: 0.25,
          },
        ],
      },
    });
    const text = await call("find_similar", { target: "handleAuth" });
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("vector.similar");
    expect(text).toContain(
      "src/server.ts:5 startServer [IMPLEMENTATION] d=0.250",
    );
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("build_context searches through the daemon", async () => {
    respond({
      search: {
        ok: true,
        data: [
          {
            metadata: { path: sourceFile },
            generated_metadata: { start_line: 0, end_line: 2 },
            defined_symbols: ["handleAuth"],
            role: "IMPLEMENTATION",
          },
        ],
      },
    });
    const text = await call("build_context", { topic: "auth" });
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("search");
    expect(text).toContain("## Entry Points");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("diff_changes lists changed-file symbols over rows.locate", async () => {
    respond({
      "rows.locate": {
        ok: true,
        rows: [[{ defined_symbols: ["handleAuth"], role: "IMPLEMENTATION" }]],
      },
    });
    const text = await call("diff_changes", {});
    expect(sendDaemonCommand.mock.calls[0][0].cmd).toBe("rows.locate");
    expect(text).toContain("1 changed file");
    expect(text).toContain("src/auth.ts (handleAuth)");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });

  it("review_risk keeps git local and asks graph.risk for the graph half", async () => {
    respond({
      "graph.risk": {
        ok: true,
        facts: [
          {
            symbol: "handleAuth",
            file: sourceFile,
            line: 9,
            callerCount: 4,
            hasTests: false,
          },
        ],
      },
    });
    const text = await call("review_risk", {});
    expect(sendDaemonCommand.mock.calls[0][0]).toMatchObject({
      cmd: "graph.risk",
      symbols: ["handleAuth"],
    });
    expect(text).toContain("handleAuth");
    expect(vectorDbCtor).not.toHaveBeenCalled();
  });
});

describe("MCP fallback policy", () => {
  /** graph.dead is representative: one verb, one in-process `runGraph*`. */
  async function deadWith(error: string) {
    sendDaemonCommand.mockResolvedValue({ ok: false, error });
    return callRaw("dead", { symbol: "handleAuth" });
  }

  it("falls back in-process for the three allowed reasons", async () => {
    for (const error of [
      "ENOENT",
      "ECONNREFUSED",
      "unknown command: graph.dead",
      "oversize",
      "daemon not ready",
      "project not watched",
    ]) {
      vectorDbCtor.mockReset();
      const result = await deadWith(error);
      expect(vectorDbCtor, `should fall back for ${error}`).toHaveBeenCalled();
      expect(result.isError, `${error} should not surface as an error`).toBe(
        undefined,
      );
    }
  });

  it("never falls back for a live daemon saying no", async () => {
    for (const error of [
      "DAEMON_BUSY",
      "timeout",
      "project not registered",
      "connection closed",
    ]) {
      vectorDbCtor.mockReset();
      const result = await deadWith(error);
      expect(
        vectorDbCtor,
        `must not open the store for ${error}`,
      ).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(error);
    }
  });

  it("refuses with the sandbox line rather than opening the store", async () => {
    const result = await deadWith("EPERM");
    expect(vectorDbCtor).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("allowUnixSockets");
    expect(result.content[0].text).not.toContain("\n    at ");
  });
});
