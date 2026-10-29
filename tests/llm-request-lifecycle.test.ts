import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ create: vi.fn(), health: vi.fn(), tool: vi.fn(), risk: vi.fn(), close: vi.fn(), append: vi.fn(), construct: vi.fn() }));
vi.mock("openai", () => ({ default: class {
  chat = { completions: { create: fake.create } };
  models = { list: fake.health };
} }));
vi.mock("../src/lib/graph/graph-builder", () => ({ GraphBuilder: class {} }));
vi.mock("../src/lib/search/searcher", () => ({ Searcher: class {} }));
vi.mock("../src/lib/store/vector-db", () => ({ VectorDB: class {
  constructor() { fake.construct(); }
  close = fake.close;
} }));
vi.mock("../src/lib/llm/config", () => ({ getLlmConfig: () => ({ host: "127.0.0.1", port: 0, model: "fixture", maxTokens: 10 }) }));
vi.mock("../src/lib/utils/project-root", () => ({ ensureProjectPaths: () => ({ lancedbDir: "/never-open" }) }));
vi.mock("../src/lib/llm/diff", () => ({
  extractDiff: () => "diff", readCommitInfo: () => ({ short: "abc", message: "fixture" }),
  extractChangedFiles: () => ["x.ts"], extractSymbols: () => ["symbol"], detectLanguages: () => [],
}));
vi.mock("../src/lib/review/risk", () => ({ gatherRiskInputs: (...args: any[]) => fake.risk(...args), computeRiskTable: () => [], formatRiskTable: () => "" }));
vi.mock("../src/lib/llm/tools", () => ({ TOOLS: [], executeTool: (...args: any[]) => fake.tool(...args) }));
vi.mock("../src/lib/llm/report", () => ({ appendReview: (...args: any[]) => fake.append(...args) }));

import { investigate } from "../src/lib/llm/investigate";
import { reviewCommit } from "../src/lib/llm/review";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function abortable(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort);
    if (signal.aborted) abort();
  });
}
const answer = (content = "answer") => ({ choices: [{ message: { content } }] });
const calls = () => ({ choices: [{ message: { content: null, tool_calls: [
  { type: "function", id: "one", function: { name: "peek", arguments: "{}" } },
  { type: "function", id: "two", function: { name: "peek", arguments: "{}" } },
] } }] });
const inv = { question: "why", projectRoot: "/fixture", maxRounds: 1 };
const rev = { commitRef: "HEAD", projectRoot: "/fixture" };
beforeEach(() => {
  vi.clearAllMocks();
  fake.health.mockReset().mockResolvedValue({ data: [] });
  fake.create.mockReset().mockResolvedValue(answer());
  fake.tool.mockReset().mockResolvedValue("context");
  fake.risk.mockReset().mockResolvedValue([]);
  fake.close.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("pre-abort prevents health, inference, native construction and report writes", async () => {
  const controller = new AbortController(); controller.abort(new Error("caller stopped"));
  await expect(investigate({ ...inv, signal: controller.signal })).rejects.toBe(controller.signal.reason);
  await expect(reviewCommit({ ...rev, signal: controller.signal })).rejects.toBe(controller.signal.reason);
  expect(fake.health).not.toHaveBeenCalled();
  expect(fake.create).not.toHaveBeenCalled();
  expect(fake.construct).not.toHaveBeenCalled();
  expect(fake.append).not.toHaveBeenCalled();
});
it("health receives cancellation, cleans its fake listener and keeps the abort reason", async () => {
  const controller = new AbortController();
  const entered = deferred<void>();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  fake.health.mockImplementation((options) => { expect(options.signal).toBe(controller.signal); entered.resolve(); return abortable(options.signal); });
  const running = investigate({ ...inv, signal: controller.signal });
  const rejected = expect(running).rejects.toBeInstanceOf(Error);
  await entered.promise;
  controller.abort(new Error("health cancelled"));
  await rejected;
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(fake.construct).not.toHaveBeenCalled();
});
it("ordinary health failure retains its actionable error", async () => {
  fake.health.mockRejectedValue(new Error("offline"));
  await expect(investigate(inv)).rejects.toThrow("Cannot connect to LLM server");
  expect(fake.construct).not.toHaveBeenCalled();
});
it.each(["investigate", "review"])("%s aborts inference through RequestOptions.signal", async (kind) => {
  const controller = new AbortController();
  const entered = deferred<void>();
  fake.create.mockImplementation((_body, options) => { expect(options.signal).toBe(controller.signal); entered.resolve(); return abortable(options.signal); });
  const running = kind === "review" ? reviewCommit({ ...rev, signal: controller.signal }) : investigate({ ...inv, signal: controller.signal });
  const rejected = expect(running).rejects.toBeInstanceOf(Error);
  await entered.promise;
  controller.abort(new Error("inference cancelled"));
  await rejected;
  expect(fake.create).toHaveBeenCalledTimes(1);
  expect(fake.append).not.toHaveBeenCalled();
  expect(fake.close).toHaveBeenCalledTimes(1);
});
it("native dispatch drains before close, skips later tools/rounds and leaves another request alone", async () => {
  const controller = new AbortController();
  const native = deferred<string>(); const entered = deferred<void>();
  fake.create.mockResolvedValueOnce(calls()).mockResolvedValue(answer("independent answer"));
  fake.tool.mockImplementation(() => { entered.resolve(); return native.promise; });
  const running = investigate({ ...inv, signal: controller.signal });
  const rejected = expect(running).rejects.toBeInstanceOf(Error);
  await entered.promise;
  controller.abort(new Error("cancelled during native dispatch"));
  expect(fake.close).not.toHaveBeenCalled();
  expect((await investigate(inv)).answer).toBe("independent answer");
  expect(fake.close).toHaveBeenCalledTimes(1);
  native.resolve("context");
  await rejected;
  expect(fake.tool).toHaveBeenCalledTimes(1);
  expect(fake.create).toHaveBeenCalledTimes(2);
  expect(fake.close).toHaveBeenCalledTimes(2);
});
it("abort between dispatches prevents the second tool and forced-final request", async () => {
  const controller = new AbortController();
  fake.create.mockResolvedValueOnce(calls());
  fake.tool.mockImplementation(async () => { controller.abort(); return "context"; });
  await expect(investigate({ ...inv, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fake.tool).toHaveBeenCalledTimes(1);
  expect(fake.create).toHaveBeenCalledTimes(1);
  expect(fake.close).toHaveBeenCalledTimes(1);
});
it("normal rounds and forced-final synthesis all receive the same signal", async () => {
  const controller = new AbortController();
  fake.create.mockResolvedValueOnce(calls()).mockResolvedValueOnce(answer("synthesis"));
  expect((await investigate({ ...inv, signal: controller.signal })).answer).toBe("synthesis");
  expect(fake.create).toHaveBeenCalledTimes(2);
  expect(fake.health).toHaveBeenCalledWith({ signal: controller.signal });
  for (const [, options] of fake.create.mock.calls) expect(options.signal).toBe(controller.signal);
  expect(fake.create.mock.calls[1][0].tools).toBeUndefined();
});
it("forced-final synthesis is cancellable without another round", async () => {
  const controller = new AbortController(); const entered = deferred<void>();
  fake.create.mockResolvedValueOnce(calls()).mockImplementationOnce((_body, options) => { entered.resolve(); return abortable(options.signal); });
  const running = investigate({ ...inv, signal: controller.signal });
  const rejected = expect(running).rejects.toBeInstanceOf(Error);
  await entered.promise; controller.abort(new Error("synthesis cancelled"));
  await rejected;
  expect(fake.create).toHaveBeenCalledTimes(2);
  expect(fake.close).toHaveBeenCalledTimes(1);
});
it("review context cancellation drains pending native work before close and clears its timer", async () => {
  vi.useFakeTimers();
  const controller = new AbortController(); const native = deferred<string>();
  fake.tool.mockReturnValue(native.promise);
  const running = reviewCommit({ ...rev, signal: controller.signal });
  const rejected = expect(running).rejects.toBeInstanceOf(Error);
  controller.abort(new Error("context cancelled"));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(fake.close).not.toHaveBeenCalled();
  native.resolve("context");
  await rejected;
  expect(fake.close).toHaveBeenCalledTimes(1);
  expect(fake.create).not.toHaveBeenCalled();
  expect(fake.append).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("review risk fallback does not swallow caller abort", async () => {
  const controller = new AbortController(); const risk = deferred<unknown[]>();
  fake.risk.mockReturnValue(risk.promise);
  const running = reviewCommit({ ...rev, signal: controller.signal });
  const rejected = expect(running).rejects.toBeInstanceOf(Error);
  controller.abort(new Error("risk cancelled")); risk.reject(new Error("native cancelled"));
  await rejected;
  expect(fake.close).toHaveBeenCalledTimes(1);
  expect(fake.create).not.toHaveBeenCalled();
  expect(fake.append).not.toHaveBeenCalled();
});
it("an abort at report construction prevents the synchronous append boundary", async () => {
  const controller = new AbortController();
  fake.create.mockResolvedValue(answer('{"findings":[],"summary":"clean"}'));
  vi.spyOn(Date.prototype, "toISOString").mockImplementationOnce(() => { controller.abort(new Error("before append")); return "fixture time"; });
  await expect(reviewCommit({ ...rev, signal: controller.signal })).rejects.toThrow("before append");
  expect(fake.append).not.toHaveBeenCalled();
});
