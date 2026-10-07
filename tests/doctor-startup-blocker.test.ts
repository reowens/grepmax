import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  reason: null as string | null,
  status: { ok: false } as Record<string, unknown>,
  vectorDbCtor: vi.fn(),
}));
vi.mock("../src/lib/utils/daemon-client", () => ({
  sendDaemonCommand: async () => h.status,
  isDaemonRunning: async () => h.status.ok,
}));
vi.mock("../src/lib/utils/autostart", () => ({
  daemonStartDeniedReason: () => h.reason,
}));
vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: class {
    constructor() {
      h.vectorDbCtor();
      throw new Error("synthetic index unavailable");
    }
  },
}));
vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

import { doctor } from "../src/commands/doctor";

describe("doctor startup containment diagnostics", () => {
  const exitCode = process.exitCode;
  beforeEach(() => {
    process.exitCode = 0;
    h.reason = null;
    h.status = { ok: false };
    h.vectorDbCtor.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  it.each([
    "host safety stop: kernel pressure unavailable",
    "daemon startup is quarantined",
  ])("reports %s even when retained index diagnostics fail", async (reason) => {
    h.reason = reason;
    await doctor.parseAsync(["--agent"], { from: "user" });
    expect(console.log).toHaveBeenCalledWith(
      `daemon_startup\tblocked=true\treason=${reason}`,
    );
    expect(process.exitCode).toBe(2);
  });

  it("reports paused availability without opening or scanning the native store", async () => {
    h.reason = "existing quarantine";
    h.status = { ok: true, service: { mode: "paused", reason: "OS warning" } };
    await doctor.parseAsync(["--agent"], { from: "user" });
    expect(console.log).toHaveBeenCalledWith(
      "daemon_service\tmode=paused\treads=bounded\treason=OS warning",
    );
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("daemon_startup"),
    );
    expect(h.vectorDbCtor).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("does not invent a startup blocker when no quarantine exists", async () => {
    await doctor.parseAsync(["--agent"], { from: "user" });
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("daemon_startup"),
    );
    expect(process.exitCode).toBe(0);
  });
});
