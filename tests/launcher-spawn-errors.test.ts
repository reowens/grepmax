import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  sendDaemonCommand: vi.fn(async () => ({ ok: false, error: "other" })),
  autostartDisabledNotice: vi.fn((): string | null => null),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/lib/utils/log-rotate", () => ({
  openRotatedLog: vi.fn(() => 999_999),
}));
vi.mock("../src/lib/utils/daemon-client", () => ({
  sendDaemonCommand: mocks.sendDaemonCommand,
}));
vi.mock("../src/lib/utils/autostart", () => ({
  autostartDisabledNotice: mocks.autostartDisabledNotice,
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
    // No daemon is listening, and starting one fails too — only then does the
    // launcher fall back to a per-project watcher.
    mocks.sendDaemonCommand.mockResolvedValueOnce({
      ok: false,
      error: "ECONNREFUSED",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const daemonChild = child();
    const spawned = child();
    mocks.spawn.mockReturnValueOnce(daemonChild).mockReturnValueOnce(spawned);

    const pending = launchWatcher("/project");
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
    daemonChild.emit(
      "error",
      Object.assign(new Error("no daemon"), { code: "ENOENT" }),
    );
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
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

  it("never spawns a per-project watcher beside a live daemon that refused", async () => {
    mocks.sendDaemonCommand.mockResolvedValueOnce({
      ok: false,
      error: "daemon initializing",
    });

    await expect(
      launchWatcher("/project", { holder: "mcp:1", pid: 1 }),
    ).resolves.toMatchObject({ ok: false, reason: "daemon-refused" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("spawns nothing when the autostart kill switch is on", async () => {
    mocks.autostartDisabledNotice.mockReturnValueOnce(
      "Daemon autostart is disabled — running in-process. Re-enable with: rm /x",
    );

    await expect(launchWatcher("/project")).resolves.toMatchObject({
      ok: false,
      reason: "autostart-disabled",
      message: expect.stringContaining("autostart is disabled"),
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
