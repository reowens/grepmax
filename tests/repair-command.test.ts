import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  vectorDb: vi.fn(),
  readGlobalConfig: vi.fn(),
  listProjects: vi.fn(),
  ensureDaemonRunning: vi.fn(),
  sendDaemonCommand: vi.fn(),
  sendStreamingCommand: vi.fn(),
}));

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: mocks.vectorDb,
}));

vi.mock("../src/lib/index/index-config", () => ({
  readGlobalConfig: mocks.readGlobalConfig,
}));

vi.mock("../src/lib/utils/project-registry", () => ({
  listProjects: mocks.listProjects,
}));

vi.mock("../src/lib/utils/daemon-client", () => ({
  ensureDaemonRunning: mocks.ensureDaemonRunning,
  sendDaemonCommand: mocks.sendDaemonCommand,
  sendStreamingCommand: mocks.sendStreamingCommand,
}));

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

import { repair } from "../src/commands/repair";

describe("repair command safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    (repair as Command).exitOverride();
  });

  it("refuses an old daemon before sending destructive IPC", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.ensureDaemonRunning.mockResolvedValue(true);
    mocks.sendDaemonCommand.mockResolvedValue({ ok: true, capabilities: {} });

    await (repair as Command).parseAsync(["--rebuild"], { from: "user" });

    expect(mocks.readGlobalConfig).not.toHaveBeenCalled();
    expect(mocks.vectorDb).not.toHaveBeenCalled();
    expect(mocks.listProjects).not.toHaveBeenCalled();
    expect(mocks.sendStreamingCommand).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to repair:",
      expect.stringContaining("does not support guarded rebuild"),
    );
    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
  });

  it("uses only the negotiated streaming rebuild protocol", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.ensureDaemonRunning.mockResolvedValue(true);
    mocks.sendDaemonCommand.mockResolvedValue({
      ok: true,
      capabilities: { exclusiveGenerationRebuild: 1 },
    });
    mocks.sendStreamingCommand.mockResolvedValue({
      type: "done",
      ok: true,
      completed: 2,
      total: 2,
    });

    await (repair as Command).parseAsync(["--rebuild"], { from: "user" });

    expect(mocks.sendStreamingCommand).toHaveBeenCalledWith(
      { cmd: "repair-v2", protocol: 1 },
      expect.any(Function),
      { timeoutMs: 86_400_000 },
    );
    expect(mocks.readGlobalConfig).not.toHaveBeenCalled();
    expect(mocks.vectorDb).not.toHaveBeenCalled();
    expect(mocks.listProjects).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });
});
