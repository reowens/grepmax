import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pid: null as string | null,
  draining: null as string | null,
  malformedFile: false,
  readError: null as string | null,
  waits: vi.fn(async () => true),
  isDraining: vi.fn(() => false),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  lstatSync: (file: string) => {
    const value = file.endsWith("daemon.pid") ? h.pid : h.draining;
    if (h.readError || value === null)
      throw Object.assign(new Error("marker read"), {
        code: h.readError ?? "ENOENT",
      });
    return {
      isFile: () => !h.malformedFile,
      isSymbolicLink: () => h.malformedFile,
    };
  },
  readFileSync: (file: string) =>
    file.endsWith("daemon.pid") ? h.pid : h.draining,
}));
vi.mock("../src/lib/utils/daemon-client", () => ({
  isDaemonDraining: h.isDraining,
  waitForDaemonDrain: h.waits,
}));

import { ProcessManager } from "../src/lib/daemon/process-manager";

describe("home-local startup arbitration", () => {
  beforeEach(() => {
    h.pid = null;
    h.draining = null;
    h.malformedFile = false;
    h.readError = null;
    h.waits.mockReset().mockResolvedValue(true);
    h.isDraining.mockReset().mockReturnValue(false);
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal !== 0) throw new Error("Host signal forbidden");
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());
  const check = () =>
    new ProcessManager({
      getShuttingDown: () => false,
    }).assertStartupAvailable();
  it("needs no global process discovery when this home has no markers", async () => {
    await expect(check()).resolves.toBeUndefined();
    expect(process.kill).not.toHaveBeenCalled();
  });
  it.each(["910001", " 910001\n"])(
    "refuses live local PID %s without signalling",
    async (pid) => {
      h.pid = pid;
      await expect(check()).rejects.toThrow(/still exists/);
      expect(process.kill).toHaveBeenCalledExactlyOnceWith(910001, 0);
    },
  );
  it("allows a definitively dead local PID without deleting markers", async () => {
    h.pid = "910001";
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    await expect(check()).resolves.toBeUndefined();
    expect(h.pid).toBe("910001");
  });
  it("refuses unknown/EPERM ownership", async () => {
    h.pid = "910001";
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("unknown"), { code: "EPERM" });
    });
    await expect(check()).rejects.toThrow(/Cannot verify daemon PID/);
    expect(h.waits).not.toHaveBeenCalled();
  });
  it.each(["910001junk", "-1", "0", "1.5", "9007199254740993"])(
    "refuses malformed PID %s",
    async (pid) => {
      h.pid = pid;
      await expect(check()).rejects.toThrow(/Cannot verify daemon marker/);
      expect(process.kill).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    "waits for local drain success=%s with no signal fallback",
    async (exited) => {
      h.draining = JSON.stringify({ pid: 910001, ts: Date.now() });
      h.isDraining.mockReturnValue(true);
      h.waits.mockResolvedValue(exited);
      if (exited) await expect(check()).resolves.toBeUndefined();
      else await expect(check()).rejects.toThrow(/still exists/);
      expect(h.waits).toHaveBeenCalledExactlyOnceWith(910001);
      expect(process.kill).toHaveBeenCalledExactlyOnceWith(910001, 0);
    },
  );
  it.each(["symlink", "unreadable"])("refuses %s markers", async (mode) => {
    h.pid = "910001";
    h.malformedFile = mode === "symlink";
    h.readError = mode === "unreadable" ? "EACCES" : null;
    await expect(check()).rejects.toThrow(/Cannot verify daemon marker/);
    expect(process.kill).not.toHaveBeenCalled();
  });
});
