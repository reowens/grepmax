import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  disabled: false,
  alive: true,
  fresh: false,
  stillAlive: true,
  draining: false,
}));
const ping = vi.hoisted(() =>
  vi.fn(
    async (): Promise<Record<string, unknown>> => ({
      ok: true,
      version: "older",
      pid: 12345,
    }),
  ),
);
const spawn = vi.hoisted(() =>
  vi.fn(async () => ({ pid: 999, logFile: "/synthetic/daemon.log" })),
);
vi.mock("../src/lib/utils/daemon-client", () => ({
  isDaemonRunning: async () => h.alive,
  daemonProcessMayExist: () => h.stillAlive,
  isDaemonDraining: () => h.draining,
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
  const exitCode = process.exitCode;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.exitCode = exitCode;
  });
  beforeEach(() => {
    h.disabled = false;
    h.alive = true;
    h.fresh = false;
    h.stillAlive = true;
    h.draining = false;
    ping.mockReset();
    ping.mockImplementation(async () => ({
      ok: true,
      version: "older",
      pid: 12345,
    }));
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
  it("version-mismatch background launch refuses a failed shutdown without spawning", async () => {
    vi.stubEnv("GMAX_DAEMON_START_ONLY", "0");
    const signal = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("Host signal forbidden");
    });
    ping
      .mockResolvedValueOnce({ ok: true, version: "older", pid: 12345 })
      .mockResolvedValueOnce({ ok: true, version: "older", pid: 12345 })
      .mockResolvedValueOnce({ ok: false, version: "older", pid: 12345 });
    await watch.parseAsync(["--daemon", "-b"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });
  it("version-mismatch launch refuses a predecessor still draining after 90 seconds", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GMAX_DAEMON_START_ONLY", "0");
    const signal = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("Host signal forbidden");
    });
    const done = watch.parseAsync(["--daemon", "-b"], { from: "user" });
    await vi.advanceTimersByTimeAsync(90_001);
    await done;
    expect(process.exitCode).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });
});

describe("read-only launch beside a busy daemon", () => {
  const exitCode = process.exitCode;
  beforeEach(() => {
    h.disabled = false;
    h.alive = false;
    h.fresh = false;
    h.stillAlive = true;
    h.draining = false;
    ping.mockReset();
    ping.mockImplementation(async () => ({ ok: true }));
    spawn.mockClear();
    vi.stubEnv("GMAX_DAEMON_START_ONLY", "0");
    vi.stubEnv("GMAX_SECONDARY_STORE", "0");
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = exitCode;
  });

  it("pauses the live daemon named in daemon.pid instead of starting a second one", async () => {
    await watch.parseAsync(["--daemon", "--read-only", "-b"], { from: "user" });
    expect(spawn).not.toHaveBeenCalled();
    expect(ping).toHaveBeenCalledWith(
      { cmd: "pause", reason: "read-only service requested" },
      { timeoutMs: 30_000 },
    );
    expect(process.exitCode).not.toBe(1);
  });

  it("reports a pause the busy daemon never accepted and still starts nothing", async () => {
    ping.mockImplementation(async () => ({ ok: false, error: "timeout" }));
    await watch.parseAsync(["--daemon", "--read-only", "-b"], { from: "user" });
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not start a competitor for a busy daemon without --read-only", async () => {
    await watch.parseAsync(["--daemon", "-b"], { from: "user" });
    expect(spawn).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it("starts a read-only daemon when daemon.pid names no live process", async () => {
    h.stillAlive = false;
    await watch.parseAsync(["--daemon", "--read-only", "-b"], { from: "user" });
    expect(spawn).toHaveBeenCalledWith({ readOnly: true });
    expect(ping).not.toHaveBeenCalled();
  });

  it("starts a successor while the named daemon is draining", async () => {
    h.draining = true;
    await watch.parseAsync(["--daemon", "-b"], { from: "user" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
