import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  factory: undefined as undefined | (() => any),
  servers: [] as any[],
  send: vi.fn(), review: vi.fn(), investigate: vi.fn(), register: vi.fn(),
  log: vi.fn(), watcher: vi.fn(),
}));
vi.mock("../src/config", () => ({
  PATHS: { globalRoot: "/fixture-home", cacheDir: "/fixture-home/cache" },
  CONFIG: { VECTOR_DIM: 384, COLBERT_DIM: 48, MODEL_TIER: "small", WORKER_THREADS: 1 },
  MODEL_TIERS: { small: { vectorDim: 384 } },
  DEFAULT_MODEL_TIER: "small", MODEL_IDS: {},
  INDEXABLE_EXTENSIONS: new Set([".ts"]), MAX_FILE_SIZE_BYTES: 2048,
  REBUILD_COMMAND: "gmax repair --rebuild",
  describeEmbeddingGap: () => null, describeSchemaDimGap: () => null,
}));
vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class {
    tools = new Map<string, any>();
    constructor(_identity: unknown, public options: any) { fake.servers.push(this); }
    registerTool(name: string, config: any, handler: any) {
      this.tools.set(name, { config, handler });
    }
  },
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio(factory: () => unknown) {
    fake.factory = factory;
    factory();
    return { close: async () => {} };
  },
}));
vi.mock("../src/lib/utils/daemon-client", () => ({ sendDaemonCommand: (...args: any[]) => fake.send(...args) }));
vi.mock("../src/lib/utils/resource-budget", () => ({
  resourceBudget: { registerClient: () => { fake.register(); return { release() {} }; } },
  WORKER_RESOURCE_RESERVE_MB: 1536,
}));
vi.mock("../src/lib/store/vector-db", () => ({ VectorDB: class { constructor() { throw new Error("Native store forbidden"); } } }));
vi.mock("../src/lib/utils/watcher-launcher", () => ({ launchWatcher: (...args: any[]) => fake.watcher(...args) }));
vi.mock("../src/lib/utils/query-log", () => ({ logQuery: (...args: any[]) => fake.log(...args) }));
vi.mock("../src/lib/utils/project-root", () => ({
  findProjectRoot: () => "/fixture",
  ensureProjectPaths: () => ({ root: "/fixture", lancedbDir: "/never-open" }),
}));
vi.mock("../src/lib/utils/project-registry", () => ({
  listProjects: () => [{ root: "/fixture", name: "fixture", status: "indexed", chunkCount: 1 }],
  getProject: () => ({ root: "/fixture", status: "indexed" }),
}));
vi.mock("../src/lib/utils/store-context", () => ({
  currentStoreContext: () => undefined,
  withStoreContext: (_root: string, work: () => unknown) => work(),
  storeInventory: () => [],
}));
vi.mock("../src/lib/utils/stores", () => ({ matchStore: () => ({ kind: "primary" }) }));
vi.mock("../src/lib/utils/repo-status", () => ({
  readRepoStatus: () => ({ indexState: "not_registered" }),
  getRepoStatus: async () => ({ indexState: "not_registered" }),
  formatRepoContext: () => "fixture repo is not_registered",
}));
vi.mock("../src/lib/index/index-config", () => ({ readGlobalConfig: () => ({}) }));
vi.mock("../src/lib/index/summaries", () => ({ generateSummaries: async () => ({ summarized: 0, remaining: 0 }) }));
vi.mock("../src/lib/llm/review", () => ({ reviewCommit: (...args: any[]) => fake.review(...args) }));
vi.mock("../src/lib/llm/investigate", () => ({ investigate: (...args: any[]) => fake.investigate(...args) }));

import { mcp } from "../src/commands/mcp";

const coreNames = ["repo_status", "list_projects", "semantic_search", "list_symbols",
  "extract_symbol", "code_skeleton", "trace_calls", "impact_analysis"];

const fullNames = ["repo_status", "semantic_search", "code_skeleton", "trace_calls",
  "extract_symbol", "peek_symbol", "dead", "audit", "surprising_connections",
  "get_neighbors", "find_paths", "subgraph_for_files", "list_symbols", "index_status",
  "list_projects", "summarize_directory", "summarize_project", "related_files",
  "recent_changes", "diff_changes", "find_tests", "impact_analysis", "find_similar",
  "build_context", "investigate", "review_commit", "review_report", "review_risk"];
const originalConsole = { ...console };
let originalTitle: string;
let listeners: Map<string, Function[]>;
let stdinListeners: Map<string, Function[]>;

beforeEach(() => {
  vi.clearAllMocks();
  fake.factory = undefined;
  fake.servers = [];
  fake.send.mockReset().mockResolvedValue({ ok: true });
  fake.review.mockReset().mockResolvedValue({ commit: "abc", clean: true, duration: 1 });
  fake.investigate.mockReset().mockResolvedValue({ answer: "answer" });
  originalTitle = process.title;
  listeners = new Map(["exit", "SIGINT", "SIGTERM", "unhandledRejection"].map((e) => [e, process.listeners(e)]));
  stdinListeners = new Map(["end", "close"].map((e) => [e, process.stdin.listeners(e)]));
  vi.stubEnv("GMAX_MCP_TOOL_PROFILE", undefined);
  vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("Exit forbidden"); }) as never);
  vi.spyOn(global, "setInterval").mockImplementation((() => { throw new Error("Background timer forbidden"); }) as never);
});
afterEach(() => {
  for (const [event, saved] of listeners)
    for (const listener of process.listeners(event))
      if (!saved.includes(listener)) process.removeListener(event, listener as any);
  for (const [event, saved] of stdinListeners)
    for (const listener of process.stdin.listeners(event))
      if (!saved.includes(listener)) process.stdin.removeListener(event, listener as any);
  Object.assign(console, originalConsole);
  process.title = originalTitle;
  process.exitCode = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function start(profile?: string) {
  vi.stubEnv("GMAX_MCP_TOOL_PROFILE", profile);
  await mcp.parseAsync(["node", "gmax"]);
  return fake.servers.at(-1);
}
function call(server: any, name: string, args = {}, signal?: AbortSignal) {
  return server.tools.get(name).handler(args, signal ? { mcpReq: { signal } } : undefined);
}

it.each([undefined, "full"])("%s preserves full28 and representative argument contracts", async (profile) => {
  const server = await start(profile);
  expect([...server.tools.keys()]).toEqual(fullNames);
  expect(server.tools.get("semantic_search").config.inputSchema.shape.query).toBeDefined();
  expect(server.tools.get("review_commit").config.inputSchema.shape.commit).toBeDefined();
  expect(server.tools.get("extract_symbol").config.inputSchema.shape.root).toBeDefined();
  expect(fake.send).not.toHaveBeenCalled();
  expect(fake.watcher).not.toHaveBeenCalled();
});
it("core is exactly eight, fixed across factory reuse and tool calls", async () => {
  const server = await start("core");
  expect([...server.tools.keys()]).toEqual(coreNames);
  expect(server.options.instructions).not.toMatch(/peek_symbol|find_tests|surprising_connections/);
  vi.stubEnv("GMAX_MCP_TOOL_PROFILE", "full");
  const response = await call(server, "semantic_search", { query: "" });
  expect(response.isError).toBe(true);
  fake.factory!();
  expect([...fake.servers.at(-1).tools.keys()]).toEqual(coreNames);
  expect(fake.watcher).not.toHaveBeenCalled();
});
it.each(["", " ", "CORE", " core", "full ", "other"])("invalid profile %j refuses before startup", async (profile) => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await start(profile);
  expect(process.exitCode).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("GMAX_MCP_TOOL_PROFILE"));
  expect(fake.servers).toHaveLength(0);
  expect(fake.register).not.toHaveBeenCalled();
  expect(fake.send).not.toHaveBeenCalled();
});
it("annotations describe setup, watch and additive effects independently of output schemas", async () => {
  const server = await start();
  for (const { config } of server.tools.values())
    expect(Object.keys(config.annotations).sort()).toEqual(["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"]);
  expect(server.tools.get("repo_status").config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  for (const name of ["semantic_search", "extract_symbol"])
    expect(server.tools.get(name).config.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  for (const name of ["list_projects", "review_commit", "review_report"])
    expect(server.tools.get(name).config.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  expect(server.tools.get("semantic_search").config.outputSchema).toBeDefined();
  expect(server.tools.get("extract_symbol").config.outputSchema).toBeUndefined();
  expect(server.tools.get("summarize_directory").config.description).toContain("disabled");
  expect((await call(server, "summarize_directory")).content[0].text).toContain("deliberately disabled");
  expect(fake.watcher).not.toHaveBeenCalled();
});
it("MCP exposes real clean success and meaningful inference failure", async () => {
  const server = await start();
  expect((await call(server, "review_commit")).content[0].text).toContain("Clean commit");
  fake.review.mockRejectedValueOnce(new Error("inference timeout"));
  const result = await call(server, "review_commit");
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("inference timeout");
});
it("pre-abort performs no IPC and startup abort never enters either library", async () => {
  const server = await start();
  const controller = new AbortController(); controller.abort();
  expect((await call(server, "investigate", { question: "why" }, controller.signal)).isError).toBe(true);
  expect(fake.send).not.toHaveBeenCalled();
  for (const name of ["investigate", "review_commit"]) {
    const abort = new AbortController();
    fake.send.mockImplementation(async (cmd: any, options: any) => {
      expect(options.signal).toBe(abort.signal);
      if (cmd.cmd === "llm-start") { abort.abort(); return { ok: false, error: "aborted" }; }
      return { ok: true };
    });
    expect((await call(server, name, { question: "why" }, abort.signal)).isError).toBe(true);
  }
  expect(fake.investigate).not.toHaveBeenCalled();
  expect(fake.review).not.toHaveBeenCalled();
  expect(fake.send.mock.calls.every(([cmd]) => ["ping", "llm-start"].includes(cmd.cmd))).toBe(true);
});
it("passes the independent caller signal through startup and into libraries", async () => {
  const server = await start();
  const controller = new AbortController();
  await call(server, "investigate", { question: "why" }, controller.signal);
  await call(server, "review_commit", {}, controller.signal);
  expect(fake.investigate).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  expect(fake.review).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
});
