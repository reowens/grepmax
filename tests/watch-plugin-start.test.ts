import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ disabled: false, alive: true, fresh: false }));
const ping = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, version: "older", pid: 12345 })),
);
const spawn = vi.hoisted(() =>
  vi.fn(async () => ({ pid: 999, logFile: "/synthetic/daemon.log" })),
);
vi.mock("../src/lib/utils/daemon-client", () => ({
  isDaemonRunning: async () => h.alive,
  isDaemonHeartbeatFresh: () => h.fresh,
  sendDaemonCommand: ping,
  readDaemonPid: vi.fn(() => 12345),
  waitForProcessExit: vi.fn(async () => true),
}));
vi.mock("../src/lib/utils/daemon-launcher", () => ({
  spawnDaemonProcess: spawn,
}));
vi.mock("../src/lib/utils/autostart", () => ({
  isAutostartDisabled: () => h.disabled,
  daemonStartDeniedReason: () =>
    h.disabled ? "daemon startup is quarantined" : null,
}));

import { watch } from "../src/commands/watch";

describe("hook-driven background daemon launch", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    h.disabled = false;
    h.alive = true;
    h.fresh = false;
    ping.mockClear();
    spawn.mockClear();
    vi.stubEnv("GMAX_DAEMON_START_ONLY", "1");
    vi.stubEnv("GMAX_SECONDARY_STORE", "0");
  });
  it("does not replace a peer that appeared after the hook absence probe", async () => {
    await watch.parseAsync(["--daemon", "-b"], { from: "user" });
    expect(ping).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
  it("honors quarantine enabled between the hook and child launch", async () => {
    h.disabled = true;
    h.alive = false;
    await watch.parseAsync(["--daemon", "-b"], { from: "user" });
    expect(spawn).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });
});
