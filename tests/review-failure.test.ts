import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ create: vi.fn(), diff: vi.fn(), append: vi.fn(), close: vi.fn(), exit: vi.fn(), context: vi.fn() }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: fake.create } }; } }));
vi.mock("../src/lib/graph/graph-builder", () => ({ GraphBuilder: class {} }));
vi.mock("../src/lib/search/searcher", () => ({ Searcher: class {} }));
vi.mock("../src/lib/store/vector-db", () => ({ VectorDB: class { close = fake.close; } }));
vi.mock("../src/lib/llm/config", () => ({ getLlmConfig: () => ({ host: "127.0.0.1", port: 0, model: "fixture", maxTokens: 10 }) }));
vi.mock("../src/lib/utils/project-root", () => ({ findProjectRoot: () => "/fixture", ensureProjectPaths: () => ({ lancedbDir: "/never-open" }) }));
vi.mock("../src/lib/utils/project-registry", () => ({ resolveRootOrExit: () => "/fixture" }));
vi.mock("../src/lib/llm/diff", () => ({
  extractDiff: () => fake.diff(), readCommitInfo: () => ({ short: "abc", message: "fixture" }),
  extractChangedFiles: () => ["file.ts"], extractSymbols: () => ["symbol"], detectLanguages: () => ["typescript"],
}));
vi.mock("../src/lib/review/risk", () => ({ gatherRiskInputs: async () => [], computeRiskTable: () => [], formatRiskTable: () => "" }));
vi.mock("../src/lib/llm/tools", () => ({ executeTool: (...args: any[]) => fake.context(...args) }));
vi.mock("../src/lib/llm/report", () => ({ appendReview: (...args: any[]) => fake.append(...args) }));
vi.mock("../src/lib/utils/daemon-client", () => ({ ensureDaemonRunning: async () => true, sendDaemonCommand: async () => ({ ok: true }) }));
vi.mock("../src/lib/utils/exit", () => ({ gracefulExit: () => fake.exit() }));

import { reviewCommit } from "../src/lib/llm/review";
import { review } from "../src/commands/review";

const options = { commitRef: "HEAD", projectRoot: "/fixture" };
const response = (content: string) => ({ choices: [{ message: { content } }] });
beforeEach(() => {
  vi.clearAllMocks();
  fake.diff.mockReset().mockReturnValue("diff");
  fake.context.mockReset().mockResolvedValue("context");
  fake.create.mockReset().mockResolvedValue(response('{"findings":[],"summary":"clean"}'));
  fake.close.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); });

it("a genuine empty diff stays clean without inference or report writes", async () => {
  fake.diff.mockReturnValue("");
  expect(await reviewCommit(options)).toEqual({ commit: "HEAD", findingCount: 0, duration: 0, clean: true });
  expect(fake.create).not.toHaveBeenCalled();
  expect(fake.append).not.toHaveBeenCalled();
});
it("successful clean JSON retains its result and persisted success shape", async () => {
  expect(await reviewCommit(options)).toEqual({ commit: "abc", findingCount: 0, duration: expect.any(Number), clean: true });
  expect(fake.append).toHaveBeenCalledWith("/fixture", expect.objectContaining({ commit: "abc", findings: [], clean: true }));
  expect(fake.close).toHaveBeenCalledTimes(1);
});
it("valid fenced findings keep findings and success shapes", async () => {
  fake.create.mockResolvedValue(response('```json\n{"findings":[{"file":"x.ts","message":"bug"}],"summary":"one"}\n```'));
  expect(await reviewCommit(options)).toEqual({ commit: "abc", findingCount: 1, duration: expect.any(Number), clean: false });
  expect(fake.append.mock.calls[0][1].findings[0]).toMatchObject({ file: "x.ts", message: "bug" });
});
it.each(["connection refused", "inference timeout"])("inference error %s rejects without a clean report", async (message) => {
  const error = new Error(message);
  fake.create.mockRejectedValue(error);
  await expect(reviewCommit(options)).rejects.toBe(error);
  expect(fake.append).not.toHaveBeenCalled();
  expect(fake.close).toHaveBeenCalledTimes(1);
});
it.each(["", "not JSON", '{"summary":"no findings array"}', '{"findings":[{}]}'])("invalid output %j cannot become clean", async (content) => {
  fake.create.mockResolvedValue(response(content));
  await expect(reviewCommit(options)).rejects.toThrow(/Review inference/);
  expect(fake.append).not.toHaveBeenCalled();
});
it("ordinary context failure still allows successful inference", async () => {
  fake.context.mockRejectedValue(new Error("context unavailable"));
  expect((await reviewCommit(options)).clean).toBe(true);
  expect(fake.close).toHaveBeenCalledTimes(1);
});
it("foreground CLI catches shared-helper failure, reports it and exits nonzero", async () => {
  fake.create.mockRejectedValue(new Error("inference timeout"));
  await review.parseAsync(["node", "gmax"]);
  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledWith("Review failed: inference timeout");
  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("clean"));
  expect(fake.exit).toHaveBeenCalledTimes(1);
  expect(fake.append).not.toHaveBeenCalled();
});
