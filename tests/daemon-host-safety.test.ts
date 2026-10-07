import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  denied: null as string | null,
  memory: "normal" as "normal" | "warn" | "critical" | "unknown",
  kernelProbe: vi.fn(),
  usage: null as {
    bytes: number;
    pressure: "ok" | "warn" | "critical";
    elements: number;
    elementSize: number;
  } | null,
  latch: vi.fn(),
  readers: [] as Array<{ options: unknown; close: ReturnType<typeof vi.fn> }>,
}));
vi.mock("../src/lib/utils/autostart", () => ({
  daemonStartDeniedReason: () => h.denied,
}));
vi.mock("../src/lib/utils/safety-latch", () => ({ latchSafetyStop: h.latch }));
vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: class {
    close = vi.fn(async () => {});
    isMaintenanceActive = () => false;
    cacheSizeBytes = () => 0;
    constructor(_dir: string, _dim: number, _lease: unknown, options: unknown) {
      h.readers.push({ options, close: this.close });
    }
  },
}));
vi.mock("../src/lib/utils/kernel-zone", () => ({
  probeKernelZoneUsage: () => {
    h.kernelProbe();
    return h.usage
      ? { status: "known", usage: h.usage }
      : { status: "unknown", reason: "timeout" };
  },
  probeMemoryPressure: () =>
    h.memory === "unknown"
      ? { status: "unknown", reason: "parse" }
      : { status: "known", pressure: h.memory },
  formatPressureProbe: () => "bounded probe diagnostic",
  formatZoneUsage: () => "kernel zone sample",
  ZONE_THRESHOLDS: { criticalBytes: 8 * 1024 ** 3 },
}));

import { Daemon } from "../src/lib/daemon/daemon";
import {
  clearReadVerbs,
  HEAVY_READ_VERBS,
  registerReadVerbs,
} from "../src/lib/daemon/read-verbs";

const daemons: any[] = [];
function makeDaemon(): any {
  const daemon = new Daemon();
  daemons.push(daemon);
  return daemon;
}

describe("daemon pressure pauses work without losing the service", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    h.denied = null;
    h.memory = "normal";
    h.kernelProbe.mockReset();
    h.latch.mockReset();
    h.readers.length = 0;
    h.usage = {
      bytes: 1024 ** 3,
      pressure: "ok",
      elements: 1,
      elementSize: 1024,
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });
  afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
      await daemon.pausePromise?.catch(() => {});
      await daemon.vectorDb?.close();
    }
    Object.defineProperty(process, "platform", platform);
    vi.restoreAllMocks();
    clearReadVerbs();
  });
  it("normal launches still refuse quarantine before stale handling or resources", async () => {
    const daemon = makeDaemon();
    const stale = vi
      .spyOn(daemon.processManager, "killStaleProcesses")
      .mockResolvedValue(undefined);
    h.denied = "existing quarantine";
    await expect(daemon.start()).rejects.toThrow("preserving containment");
    expect(stale).not.toHaveBeenCalled();
    expect(h.latch).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "critical startup refuses even readOnly=%s",
    async (readOnly) => {
      const daemon = makeDaemon();
      h.memory = "critical";
      const stale = vi
        .spyOn(daemon.processManager, "killStaleProcesses")
        .mockResolvedValue(undefined);
      await expect(daemon.start({ readOnly })).rejects.toThrow(
        "startup safety stop",
      );
      expect(stale).not.toHaveBeenCalled();
      expect(h.latch).toHaveBeenCalledOnce();
      expect(h.readers).toHaveLength(0);
    },
  );
  it.each(["warn", "unknown"] as const)(
    "OS %s permits only a paused service, not heavy work",
    async (pressure) => {
      h.memory = pressure;
      const daemon = makeDaemon();
      daemon.ready = true;
      const shutdown = vi
        .spyOn(daemon, "shutdown")
        .mockResolvedValue(undefined);
      const effect = vi.fn(async () => true);
      await expect(
        daemon.runSharedOperation("search", undefined, effect),
      ).rejects.toThrow("unsafe or unknown");
      await daemon.pausePromise;
      expect(effect).not.toHaveBeenCalled();
      expect(shutdown).not.toHaveBeenCalled();
      expect(h.latch).not.toHaveBeenCalled();
      expect(daemon.isReady()).toBe(true);
      expect(daemon.serviceStatus().mode).toBe("paused");
      expect(h.kernelProbe).toHaveBeenCalled();
      expect(h.readers[0].options).toEqual({
        readOnly: true,
        indexCacheMb: 32,
        metadataCacheMb: 16,
      });
      expect(
        await daemon.runSharedOperation(
          "rows.locate",
          undefined,
          async () => "retained row",
        ),
      ).toBe("retained row");
    },
  );
  it.each(["warn", "unknown"] as const)(
    "kernel %s pauses a young daemon without a latch or relaunch",
    async (pressure) => {
      h.usage =
        pressure === "unknown" ? null : { ...h.usage!, pressure: "warn" };
      const daemon = makeDaemon();
      const shutdown = vi
        .spyOn(daemon, "shutdown")
        .mockResolvedValue(undefined);
      expect(daemon.checkKernelZonePressure()).toBe(false);
      await daemon.pausePromise;
      expect(daemon.serviceStatus().mode).toBe("paused");
      expect(shutdown).not.toHaveBeenCalled();
      expect(h.latch).not.toHaveBeenCalled();
      expect(daemon.recycling).toBe(false);
    },
  );
  it("detects kernel critical pressure even while OS memory already warns", async () => {
    h.memory = "warn";
    h.usage = { ...h.usage!, pressure: "critical" };
    const daemon = makeDaemon();
    const order: string[] = [];
    h.latch.mockImplementation(() => {
      order.push("latch");
    });
    vi.spyOn(daemon, "shutdown").mockImplementation(async () => {
      order.push("shutdown");
    });
    expect(daemon.checkKernelZonePressure()).toBe(false);
    expect(order).toEqual(["latch", "shutdown"]);
    expect(daemon.recycling).toBe(true);
  });
  it.each([true, false])(
    "critical beats recycle and MLX health at sampled=%s",
    async (sampled) => {
      h.memory = "critical";
      const daemon = makeDaemon();
      vi.spyOn(daemon, "shutdown").mockResolvedValue(undefined);
      const recycle = vi.spyOn(daemon, "maybeRecycle");
      const mlx = vi.spyOn(daemon.mlxServerManager, "checkMlxHealth");
      daemon.runHeartbeatMaintenance(sampled);
      expect(h.latch).toHaveBeenCalledOnce();
      expect(recycle).not.toHaveBeenCalled();
      expect(mlx).not.toHaveBeenCalled();
    },
  );
  it("new quarantine pauses work while preserving the service and marker ownership", async () => {
    const daemon = makeDaemon();
    h.denied = "new user quarantine";
    const shutdown = vi.spyOn(daemon, "shutdown").mockResolvedValue(undefined);
    const recycle = vi.spyOn(daemon, "maybeRecycle");
    const mlx = vi.spyOn(daemon.mlxServerManager, "checkMlxHealth");
    daemon.runHeartbeatMaintenance(true);
    await daemon.pausePromise;
    expect(shutdown).not.toHaveBeenCalled();
    expect(h.latch).not.toHaveBeenCalled();
    expect(recycle).not.toHaveBeenCalled();
    expect(mlx).not.toHaveBeenCalled();
    expect(daemon.serviceStatus()).toEqual({
      mode: "paused",
      reason: "new user quarantine",
    });
  });
  it("pausing cancels admitted work, tears down heavy resources, and keeps read admission open", async () => {
    const daemon = makeDaemon();
    daemon.ready = true;
    const db = {
      close: vi.fn(async () => {}),
      abortLeaseWaits: vi.fn(),
      pauseMaintenanceLoop: vi.fn(),
    };
    const pool = { destroy: vi.fn(async () => {}) };
    daemon.vectorDb = db;
    daemon.workerPool = pool;
    const stopMlx = vi
      .spyOn(daemon.mlxServerManager, "stopMlxServer")
      .mockResolvedValue(undefined);
    const task = daemon.operations.runShared(
      "watch-batch",
      undefined,
      (signal: AbortSignal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    void task.catch(() => {});
    daemon.pauseWork("memory warning");
    await expect(task).rejects.toThrow("paused");
    await daemon.pausePromise;
    expect(pool.destroy).toHaveBeenCalledOnce();
    expect(stopMlx).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(daemon.operations.status).toBe("open");
    expect(daemon.isReady()).toBe(true);
    expect(
      await daemon.runSharedOperation("rows.locate", undefined, async () => 42),
    ).toBe(42);
    const effect = vi.fn(async () => true);
    await expect(
      daemon.runSharedOperation("index-project", undefined, effect),
    ).rejects.toMatchObject({ code: "DAEMON_PAUSED" });
    expect(effect).not.toHaveBeenCalled();
    expect(daemon.checkKernelZonePressure()).toBe(false);
    expect(daemon.serviceStatus().mode).toBe("paused");
  });
  it("does not reopen a reader while an old native operation is still draining", async () => {
    const daemon = makeDaemon();
    let finish!: () => void;
    const old = daemon.operations.runShared(
      "native-read",
      undefined,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    daemon.pauseWork("warning");
    await Promise.resolve();
    expect(h.readers).toHaveLength(0);
    finish();
    await old;
    await daemon.pausePromise;
    expect(h.readers).toHaveLength(1);
  });
  it("paused reads still stop before native work if pressure becomes critical", async () => {
    const daemon = makeDaemon();
    daemon.pauseWork("warning");
    await daemon.pausePromise;
    h.memory = "critical";
    vi.spyOn(daemon, "shutdown").mockResolvedValue(undefined);
    const effect = vi.fn(async () => true);
    await expect(
      daemon.runSharedOperation("rows.locate", undefined, effect),
    ).rejects.toThrow("closing");
    expect(effect).not.toHaveBeenCalled();
    expect(h.latch).toHaveBeenCalledOnce();
  });
  it.each([
    "watch",
    "watch-batch",
    "index-project",
    "add-project",
    "remove-project",
    "search",
    "llm-start",
    "review",
    "summarize-project",
    ...HEAVY_READ_VERBS,
  ])("refuses %s under quarantine before side effects", async (name) => {
    const daemon = makeDaemon();
    h.denied = "quarantine";
    const effect = vi.fn(async () => true);
    await expect(
      daemon.runSharedOperation(name, undefined, effect),
    ).rejects.toThrow("refused");
    expect(effect).not.toHaveBeenCalled();
  });
  it("normal cheap reads keep their existing behavior", async () => {
    registerReadVerbs({ "graph.resolve": async () => ({ ok: true }) });
    const daemon = makeDaemon();
    h.denied = "quarantine";
    expect(
      await daemon.runSharedOperation(
        "graph.resolve",
        undefined,
        async () => true,
      ),
    ).toBe(true);
  });
  it("rechecks OS pressure and quarantine after the kernel sample", async () => {
    const daemon = makeDaemon();
    h.kernelProbe.mockImplementation(() => {
      h.memory = "warn";
    });
    const effect = vi.fn(async () => true);
    await expect(
      daemon.runSharedOperation("search", undefined, effect),
    ).rejects.toThrow("refused");
    expect(effect).not.toHaveBeenCalled();
    expect(h.latch).not.toHaveBeenCalled();
    h.memory = "normal";
    h.kernelProbe.mockImplementation(() => {
      h.denied = "new quarantine";
    });
    const other = makeDaemon();
    await expect(
      other.runSharedOperation("search", undefined, effect),
    ).rejects.toThrow("new quarantine");
  });
  it("does not load MLX or an LLM from a quarantined or warning service", async () => {
    const daemon = makeDaemon();
    h.memory = "warn";
    const start = vi
      .spyOn(daemon.mlxServerManager, "ensureMlxServer")
      .mockResolvedValue(undefined);
    await expect(daemon.ensureAdmittedMlxServer("model")).rejects.toThrow(
      "refused",
    );
    expect(start).not.toHaveBeenCalled();
    await daemon.pausePromise;
    daemon.llmServer = { start: vi.fn() };
    await expect(daemon.llmStart()).rejects.toMatchObject({
      code: "DAEMON_PAUSED",
    });
    expect(daemon.llmServer.start).not.toHaveBeenCalled();
  });
});
