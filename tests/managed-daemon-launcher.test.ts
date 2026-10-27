import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  unit: vi.fn(),
  start: vi.fn(),
  spawn: vi.fn(),
  log: vi.fn(),
  denied: vi.fn(),
  gemma: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: h.spawn }));
vi.mock("../src/lib/utils/service-startup", () => ({
  installedUserDaemonService: h.unit,
  startUserDaemonService: h.start,
}));
vi.mock("../src/lib/utils/autostart", () => ({
  daemonStartDeniedReason: h.denied,
  autostartDisabledNotice: () => null,
}));
vi.mock("../src/lib/workers/embeddings/gemma2", () => ({
  isGemma2Profile: h.gemma,
}));
vi.mock("../src/lib/utils/log-rotate", () => ({ openRotatedLog: h.log }));
vi.mock("../src/lib/utils/daemon-client", () => ({
  sendDaemonCommand: async () => ({ ok: false, error: "ENOENT" }),
}));
vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: () => ({ root: "/project" }),
}));
vi.mock("../src/lib/utils/store-access", () => ({
  storeWriteDeniedNotice: () => null,
}));

import {
  spawnDaemon,
  spawnDaemonProcess,
} from "../src/lib/utils/daemon-launcher";
import { launchWatcher } from "../src/lib/utils/watcher-launcher";

beforeEach(() => {
  vi.clearAllMocks();
  h.unit.mockReturnValue("hetchy-gmax.service");
  h.start.mockResolvedValue(42);
  h.denied.mockReturnValue(null);
  h.gemma.mockReturnValue(false);
});
afterEach(() => vi.restoreAllMocks());

describe("all daemon launcher entry points honor service ownership", () => {
  it("implicit CLI/MCP startup returns the managed PID without detaching", async () => {
    expect(await spawnDaemon()).toBe(42);
    expect(h.start).toHaveBeenCalledWith("hetchy-gmax.service");
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalled();
  });
  it("the background hook launcher uses the same managed start", async () => {
    expect(await spawnDaemonProcess()).toMatchObject({
      pid: 42,
      service: "hetchy-gmax.service",
    });
    expect(h.start).toHaveBeenCalledWith("hetchy-gmax.service", {});
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it("reports managed failure without falling back to a detached daemon", async () => {
    h.start.mockRejectedValue(Error("unit failed"));
    await expect(spawnDaemon()).rejects.toThrow("unit failed");
    await expect(spawnDaemonProcess()).rejects.toThrow("unit failed");
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it("MCP/watch startup cannot replace failed service with a per-project watcher", async () => {
    h.start.mockRejectedValue(Error("unit failed"));
    expect(await launchWatcher("/project", { holder: "mcp:1" })).toMatchObject({
      ok: false,
      reason: "daemon-refused",
      message: "unit failed",
    });
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it("unknown installed-owner state cannot fall through to a watcher", async () => {
    h.unit.mockImplementationOnce(() => {
      throw Error("cannot verify service");
    });
    expect(await launchWatcher("/project", { holder: "mcp:1" })).toMatchObject({
      ok: false,
      reason: "daemon-refused",
      message: "cannot verify service",
    });
    expect(h.start).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it("quarantine blocks both routes before service discovery or commands", async () => {
    h.denied.mockReturnValue("quarantined");
    expect(await spawnDaemon()).toBeNull();
    await expect(spawnDaemonProcess()).rejects.toThrow("quarantined");
    expect(h.unit).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it("Gemma admission still blocks both routes", async () => {
    h.gemma.mockReturnValue(true);
    expect(await spawnDaemon()).toBeNull();
    await expect(spawnDaemonProcess()).rejects.toThrow("Gemma profiles");
    expect(h.unit).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });
  it("preserves read-only intent for the managed startup boundary", async () => {
    h.denied.mockReturnValue("quarantined");
    h.start.mockRejectedValue(Error("configure read-only service"));
    await expect(spawnDaemonProcess({ readOnly: true })).rejects.toThrow(
      "configure read-only service",
    );
    expect(h.start).toHaveBeenCalledWith("hetchy-gmax.service", {
      readOnly: true,
    });
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
