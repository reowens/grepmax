import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  denied: null as string | null,
  usage: null as {
    bytes: number;
    pressure: "ok" | "warn" | "critical";
    elements: number;
    elementSize: number;
  } | null,
  latch: vi.fn(),
}));
vi.mock("../src/lib/utils/autostart", () => ({
  daemonStartDeniedReason: () => h.denied,
}));
vi.mock("../src/lib/utils/safety-latch", () => ({ latchSafetyStop: h.latch }));
vi.mock("../src/lib/utils/kernel-zone", () => ({
  readKernelZoneUsage: () => h.usage,
  formatZoneUsage: () => "kernel zone sample",
  ZONE_THRESHOLDS: { criticalBytes: 8 * 1024 ** 3 },
}));

import { Daemon } from "../src/lib/daemon/daemon";

describe("daemon host protection before startup and recycling", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    h.denied = null;
    h.usage = {
      bytes: 9 * 1024 ** 3,
      pressure: "critical",
      elements: 1,
      elementSize: 1024,
    };
    h.latch.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.restoreAllMocks();
  });
  it("refuses quarantine before stale process handling or resource creation", async () => {
    const daemon: any = new Daemon();
    const stale = vi
      .spyOn(daemon.processManager, "killStaleProcesses")
      .mockResolvedValue(undefined);
    h.denied = "existing quarantine";
    await expect(daemon.start()).rejects.toThrow("preserving containment");
    expect(stale).not.toHaveBeenCalled();
    expect(h.latch).not.toHaveBeenCalled();
  });
  it("latches critical startup pressure before opening any resources", async () => {
    const daemon: any = new Daemon();
    const stale = vi
      .spyOn(daemon.processManager, "killStaleProcesses")
      .mockResolvedValue(undefined);
    await expect(daemon.start()).rejects.toThrow("startup safety stop");
    expect(h.latch).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
  });
  it("refuses startup with unknown kernel pressure without treating it as healthy", async () => {
    h.usage = null;
    const daemon: any = new Daemon();
    await expect(daemon.start()).rejects.toThrow("kernel pressure unavailable");
  });
  it.each(["warn", "critical", "unknown"])(
    "stops a young daemon at %s without relaunch",
    async (pressure) => {
      h.usage =
        pressure === "unknown"
          ? null
          : { ...h.usage!, pressure: pressure as "warn" | "critical" };
      const daemon: any = new Daemon();
      const shutdown = vi
        .spyOn(daemon, "shutdown")
        .mockResolvedValue(undefined);
      vi.spyOn(process, "uptime").mockReturnValue(10);
      expect(daemon.checkKernelZonePressure()).toBe(false);
      expect(h.latch).toHaveBeenCalledOnce();
      expect(shutdown).toHaveBeenCalledWith();
      expect(daemon.recycling).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
    },
  );
  it("records the safety stop before shutdown", async () => {
    const daemon: any = new Daemon();
    const order: string[] = [];
    h.latch.mockImplementation(() => {
      order.push("latch");
    });
    vi.spyOn(daemon, "shutdown").mockImplementation(async () => {
      order.push("shutdown");
    });
    daemon.checkKernelZonePressure();
    expect(order).toEqual(["latch", "shutdown"]);
    await Promise.resolve();
    await Promise.resolve();
  });
  it.each([true, false])(
    "critical pressure wins before recycle and MLX work on sampled=%s",
    async (sampled) => {
      const daemon: any = new Daemon();
      vi.spyOn(daemon, "shutdown").mockResolvedValue(undefined);
      const recycle = vi.spyOn(daemon, "maybeRecycle");
      const mlx = vi
        .spyOn(daemon.mlxServerManager, "checkMlxHealth")
        .mockResolvedValue(undefined);
      daemon.runHeartbeatMaintenance(sampled);
      expect(h.latch).toHaveBeenCalledOnce();
      expect(recycle).not.toHaveBeenCalled();
      expect(mlx).not.toHaveBeenCalled();
      await Promise.resolve();
      await Promise.resolve();
    },
  );
  it("observes a newly set quarantine before recycling/MLX and preserves its marker ownership", async () => {
    const daemon: any = new Daemon();
    h.denied = "new user quarantine";
    h.usage = { ...h.usage!, pressure: "ok" };
    const shutdown = vi.spyOn(daemon, "shutdown").mockResolvedValue(undefined);
    const recycle = vi.spyOn(daemon, "maybeRecycle");
    const mlx = vi
      .spyOn(daemon.mlxServerManager, "checkMlxHealth")
      .mockResolvedValue(undefined);
    daemon.runHeartbeatMaintenance(true);
    expect(shutdown).toHaveBeenCalledWith();
    expect(h.latch).not.toHaveBeenCalled();
    expect(recycle).not.toHaveBeenCalled();
    expect(mlx).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
  });
  it.each([
    "watch",
    "watch-batch",
    "watch-catchup",
    "index-project",
    "add-project",
    "remove-project",
    "search-warmup",
    "store-maintenance",
    "llm-start",
    "review",
    "summarize-project",
  ])("refuses %s before any heavy callback under quarantine", async (name) => {
    const daemon: any = new Daemon();
    h.denied = "quarantine";
    const effect = vi.fn(async () => true);
    await expect(
      daemon.runSharedOperation(name, undefined, effect),
    ).rejects.toThrow("refused");
    expect(effect).not.toHaveBeenCalled();
  });
  it.each(["project-stats", "llm-stop", "unwatch"])(
    "preserves safe %s operations during quarantine",
    async (name) => {
      const daemon: any = new Daemon();
      h.denied = "quarantine";
      const effect = vi.fn(async () => true);
      await expect(
        daemon.runSharedOperation(name, undefined, effect),
      ).resolves.toBe(true);
      expect(effect).toHaveBeenCalledOnce();
    },
  );
  it("does not load an LLM from an already running daemon under quarantine", async () => {
    const daemon: any = new Daemon();
    h.denied = "quarantine";
    daemon.llmServer = { start: vi.fn() };
    await expect(daemon.llmStart()).rejects.toThrow("refused");
    expect(daemon.llmServer.start).not.toHaveBeenCalled();
  });
  it("rejects unknown fresh kernel pressure before a heavy operation callback", async () => {
    const daemon: any = new Daemon();
    h.usage = null;
    vi.spyOn(daemon, "shutdown").mockResolvedValue(undefined);
    const effect = vi.fn(async () => true);
    await expect(
      daemon.runSharedOperation("watch-batch", undefined, effect),
    ).rejects.toThrow("unsafe or unknown");
    expect(effect).not.toHaveBeenCalled();
    expect(h.latch).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
  });
});
