import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  sendDaemonCommand: vi.fn(async () => ({ ok: false, error: "other" })),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/lib/utils/log-rotate", () => ({
  openRotatedLog: vi.fn(() => 999_999),
}));
vi.mock("../src/lib/utils/daemon-client", () => ({
  sendDaemonCommand: mocks.sendDaemonCommand,
}));
vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: vi.fn(() => ({ root: "/project" })),
}));
vi.mock("../src/lib/utils/watcher-store", () => ({
  getWatcherCoveringPath: vi.fn(() => undefined),
  getWatcherForProject: vi.fn(() => undefined),
  isProcessRunning: vi.fn(() => false),
}));

import { spawnDaemon as realSpawnDaemon } from "../src/lib/utils/daemon-launcher";
import { launchWatcher } from "../src/lib/utils/watcher-launcher";

function child(pid?: number) {
  const value = new EventEmitter() as EventEmitter & {
    pid?: number;
    unref: ReturnType<typeof vi.fn>;
  };
  value.pid = pid;
  value.unref = vi.fn();
  return value;
}

describe("detached spawn error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not report daemon success before spawn and handles ENOENT", async () => {
    const spawned = child(1234);
    mocks.spawn.mockReturnValue(spawned);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = realSpawnDaemon();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    spawned.emit(
      "error",
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    await expect(pending).resolves.toBeNull();
    expect(spawned.unref).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to spawn daemon"),
    );
  });

  it("returns watcher spawn errors instead of emitting them uncaught", async () => {
    const spawned = child();
    mocks.spawn.mockReturnValue(spawned);

    const pending = launchWatcher("/project");
    await Promise.resolve();
    await Promise.resolve();
    spawned.emit(
      "error",
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );

    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: "spawn-failed",
      message: expect.stringContaining("missing"),
    });
    expect(spawned.unref).not.toHaveBeenCalled();
  });
});
