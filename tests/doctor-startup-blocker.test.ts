import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ reason: null as string | null }));
vi.mock("../src/lib/utils/autostart", () => ({
  daemonStartDeniedReason: () => h.reason,
}));
vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: class {
    constructor() {
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

  it("does not invent a startup blocker when no quarantine exists", async () => {
    await doctor.parseAsync(["--agent"], { from: "user" });
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("daemon_startup"),
    );
    expect(process.exitCode).toBe(0);
  });
});
