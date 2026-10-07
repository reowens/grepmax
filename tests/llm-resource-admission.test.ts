import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmServer } from "../src/lib/llm/server";
import { resourceBudget } from "../src/lib/utils/resource-budget";

vi.mock("../src/lib/utils/log-rotate", () => ({
  openRotatedLog: vi.fn(() => 42),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
  };
});

describe("LLM resource admission without starting any model", () => {
  afterEach(() => vi.restoreAllMocks());
  const make = () => {
    const server = new LlmServer() as any;
    server.config = {
      binary: "fixture",
      model: "/fixture/unloaded.gguf",
      host: "127.0.0.1",
      port: 8079,
    };
    vi.spyOn(server, "isEnabled").mockReturnValue(true);
    vi.spyOn(server, "readPid").mockReturnValue(null);
    vi.spyOn(server, "healthy").mockResolvedValue(false);
    return server;
  };
  it("reserves model bytes plus runtime headroom before any spawn", async () => {
    const server = make();
    vi.mocked(childProcess.execSync).mockReturnValue(Buffer.alloc(0));
    const spawn = vi.mocked(childProcess.spawn);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({
      size: 8 * 1024 ** 3,
    } as fs.Stats);
    vi.mocked(resourceBudget.reserve).mockImplementationOnce(() => {
      throw Error("budget exceeded");
    });
    await expect(server.start()).rejects.toThrow("budget exceeded");
    expect(resourceBudget.reserve).toHaveBeenCalledWith(8704, "llm");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("requires a measurable adopted process before starting its watchdog", async () => {
    const server = make();
    vi.mocked(server.healthy).mockResolvedValue(true);
    vi.mocked(resourceBudget.check).mockImplementationOnce(() => {
      throw Error("process identity unavailable");
    });
    await expect(server.start()).rejects.toThrow("identity unavailable");
    expect(server.idleTimer).toBeNull();
  });
});
