import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  closeSync: vi.fn(),
  execSync: vi.fn(),
  existsSync: vi.fn(),
  httpGet: vi.fn(),
  openRotatedLog: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: h.execSync,
    spawn: h.spawn,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: h.closeSync,
    existsSync: h.existsSync,
  };
});

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    get: h.httpGet,
  };
});

vi.mock("../src/lib/utils/log-rotate", () => ({
  openRotatedLog: h.openRotatedLog,
}));

import { MlxServerManager } from "../src/lib/daemon/mlx-server-manager";

describe("MlxServerManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.execSync.mockImplementation(() => {
      throw new Error("no process on port");
    });
    h.existsSync.mockImplementation((p: string) => p.endsWith("server.py"));
    h.openRotatedLog.mockReturnValue(42);
    h.httpGet.mockImplementation(() => {
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      queueMicrotask(() => req.emit("error", new Error("down")));
      return req;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to CPU embeddings when uv fails to spawn", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const child = new EventEmitter() as any;
    child.pid = 1234;
    child.unref = vi.fn();
    h.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn uv ENOENT")));
      return child;
    });

    const manager = new MlxServerManager({ getShuttingDown: () => false });

    await expect(manager.ensureMlxServer()).resolves.toBeUndefined();

    expect(h.spawn).toHaveBeenCalledWith(
      "uv",
      ["run", "python", "server.py"],
      expect.objectContaining({ detached: true }),
    );
    expect(child.unref).toHaveBeenCalled();
    expect(h.closeSync).toHaveBeenCalledWith(42);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("falling back to CPU embeddings"),
    );
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
