import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../src/lib/utils/resource-budget");
vi.unmock("../src/lib/utils/host-resource");

import type { HostResourceSnapshot } from "../src/lib/utils/host-resource";
import {
  assertResourceSnapshot,
  ResourceBudget,
  resolveResourceBudgetMb,
} from "../src/lib/utils/resource-budget";

function snapshot(): HostResourceSnapshot {
  return {
    at: 1000,
    completedAt: 1000,
    platform: "darwin",
    aggregateFootprintMb: 200,
    physicalFreeMb: 4096,
    swapUsedMb: 0,
    memoryPressure: "normal",
    kernelPressure: "ok",
    kernelBytes: 1048576,
    incompleteReasons: [],
    processes: [
      {
        pid: 10,
        parentPid: 1,
        groupPid: 10,
        start: "parent",
        role: "daemon",
        footprintMb: 100,
      },
      {
        pid: 20,
        parentPid: 1,
        groupPid: 20,
        start: "client",
        role: "client",
        footprintMb: 100,
      },
    ],
  };
}
describe("one persistent budget for all clients/stores", () => {
  let root: string;
  let s: HostResourceSnapshot;
  let latch: ReturnType<typeof vi.fn<(reason: string) => void>>;
  let signal: ReturnType<typeof vi.fn<(pid: number) => void>>;
  const make = (pid = 10, extra = {}) =>
    new ResourceBudget({
      root,
      policy: () => "strict",
      platform: "darwin",
      pid,
      now: () => 1000,
      sample: () => s,
      latch,
      signal,
      quarantine: () => null,
      processStart: () => s.processes.find((p) => p.pid === pid)!.start,
      ...extra,
    });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-budget-test-"));
    s = snapshot();
    latch = vi.fn();
    signal = vi.fn();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const records = () => fs.readdirSync(root).filter((n) => n.endsWith(".json"));
  it("recovery can account for legacy client footprints without requiring reconnects", () => {
    s.processes[1].role = "mcp";
    const budget = make(10, { requireClientRegistration: false });
    const reservation = budget.reserve(512, "prune-helper");
    expect(records()).toHaveLength(1);
    reservation.release();
    s.memoryPressure = "warn";
    expect(() => budget.reserve(512, "prune-helper")).toThrow("warning");
    s.memoryPressure = "unknown";
    expect(() => budget.reserve(512, "prune-helper")).toThrow("unknown");
  });
  it.each(["warn", "unknown"] as const)(
    "explicit critical-only allows %s without a ledger or client reconnect",
    (pressure) => {
      s.memoryPressure = pressure;
      s.aggregateFootprintMb = null;
      s.incompleteReasons = ["probe timeout"];
      const sample = vi.fn(() => s);
      const budget = make(10, {
        policy: () => "critical-only",
        criticalSample: sample,
      });
      const reservation = budget.reserve(1536, "worker");
      reservation.attach(30, true);
      reservation.release();
      expect(budget.check()).toBe(s);
      expect(records()).toHaveLength(0);
      expect(latch).not.toHaveBeenCalled();
    },
  );
  it.each(["memoryPressure", "kernelPressure"] as const)(
    "critical-only still latches %s",
    (key) => {
      s[key] = "critical";
      const budget = make(10, {
        policy: () => "critical-only",
        criticalSample: () => s,
      });
      expect(() => budget.reserve(1536, "worker")).toThrow(
        "critical host pressure",
      );
      expect(latch).toHaveBeenCalledOnce();
    },
  );
  it("critical-only never clears an existing stop and verifies adopted PID liveness", () => {
    const budget = make(10, {
      policy: () => "critical-only",
      criticalSample: () => s,
    });
    budget.check(123);
    expect(signal).toHaveBeenCalledWith(123);
    expect(() =>
      make(10, {
        policy: () => "critical-only",
        criticalSample: () => s,
        quarantine: () => "critical stop",
      }).check(),
    ).toThrow("critical stop");
  });
  it("counts another session's pending reservation before it has allocated native memory", () => {
    vi.stubEnv("GMAX_RESOURCE_BUDGET_MB", "2048");
    const first = make().reserve(1536, "worker");
    expect(() => make(20).reserve(512, "other-store")).toThrow(
      "budget exceeded",
    );
    expect(records()).toHaveLength(1);
    first.release();
    expect(() => make(20).reserve(512, "other-store")).not.toThrow();
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, records()[0])).mode & 0o777).toBe(0o600);
  });
  it("does not make a child free when its parent already has a large footprint", () => {
    vi.stubEnv("GMAX_RESOURCE_BUDGET_MB", "2048");
    s.processes[0].footprintMb = 1800;
    s.aggregateFootprintMb = 1900;
    expect(() => make().reserve(512, "worker")).toThrow("budget exceeded");
  });
  it("does not double-count reserved native allocations as they become resident", () => {
    vi.stubEnv("GMAX_RESOURCE_BUDGET_MB", "2048");
    make().reserve(1024, "native-store");
    s.processes[0].footprintMb = 1100;
    s.aggregateFootprintMb = 1200;
    expect(() => make().reserve(512, "second-store")).not.toThrow();
    expect(() => make().reserve(512, "third-store")).toThrow("budget exceeded");
  });
  it("transfers child reservations and preserves them after parent exit", () => {
    const reservation = make().reserve(1536, "worker");
    s.processes.push({
      pid: 30,
      parentPid: 10,
      groupPid: 30,
      start: "child",
      role: "worker",
      footprintMb: 100,
    });
    s.aggregateFootprintMb = 300;
    reservation.attach(30);
    const record = JSON.parse(
      fs.readFileSync(path.join(root, records()[0]), "utf8"),
    );
    expect(record.pid).toBe(30);
    expect(record.mb).toBe(1536);
    s.processes = s.processes.filter((p) => p.pid !== 10);
    s.processes[1].parentPid = 1;
    expect(() => make(20).check()).not.toThrow();
    expect(records()).toHaveLength(1);
    reservation.release();
    expect(records()).toHaveLength(0);
  });
  it("retains a dead launcher's charge while its process group remains alive", () => {
    const reservation = make().reserve(1024, "embedding");
    s.processes.push({
      pid: 30,
      parentPid: 10,
      groupPid: 30,
      start: "launcher",
      role: "helper",
      footprintMb: 100,
    });
    reservation.attach(30, true);
    s.processes = s.processes.filter((p) => p.pid !== 30);
    expect(() => make().check()).toThrow("owner missing");
    expect(signal).toHaveBeenCalledWith(-30);
    expect(records()).toHaveLength(1);
    signal.mockImplementation(() => {
      throw Object.assign(Error(), { code: "ESRCH" });
    });
    expect(() => make().check()).not.toThrow();
    expect(records()).toHaveLength(0);
  });
  it("retains an uncertain fork across parent death until the child is confirmed dead", () => {
    const reservation = make().reserve(1024, "embedding");
    expect(() => reservation.attach(30, true)).toThrow("identity unavailable");
    s.processes = s.processes.filter((p) => p.pid !== 10);
    expect(() => make(20).check()).toThrow("unverified launched process");
    expect(records()).toHaveLength(1);
    signal.mockImplementation(() => {
      throw Object.assign(Error(), { code: "ESRCH" });
    });
    expect(() => make(20).check()).not.toThrow();
    expect(records()).toHaveLength(0);
  });
  it("reaps only verified dead/reused owners; unknown liveness stays refused", () => {
    make().reserve(512, "native-store");
    s.processes = s.processes.filter((p) => p.pid !== 10);
    signal.mockImplementation(() => {
      throw Object.assign(Error(), { code: "EPERM" });
    });
    expect(() => make(20).check()).toThrow("owner missing");
    expect(records()).toHaveLength(1);
    signal.mockImplementation(() => {
      throw Object.assign(Error(), { code: "ESRCH" });
    });
    expect(() => make(20).check()).not.toThrow();
    expect(records()).toHaveLength(0);
    s = snapshot();
    make().reserve(512, "native-store");
    s.processes[0].start = "reused";
    expect(() => make(20).check()).not.toThrow();
    expect(records()).toHaveLength(0);
  });
  it.each(["warn", "unknown"] as const)(
    "pauses on %s without creating a persistent stop",
    (pressure) => {
      s.memoryPressure = pressure;
      expect(() => make().reserve(512, "worker")).toThrow("paused");
      expect(latch).not.toHaveBeenCalled();
      expect(records()).toHaveLength(0);
    },
  );
  it("latches known critical pressure before refusing expansion", () => {
    s.kernelPressure = "critical";
    expect(() => make().reserve(512, "worker")).toThrow("critical");
    expect(latch).toHaveBeenCalledOnce();
    expect(records()).toHaveLength(0);
  });
  it("retains the critical classification when latch persistence fails", () => {
    s.memoryPressure = "critical";
    latch.mockImplementation(() => {
      throw Error("unwritable");
    });
    try {
      make().reserve(512, "worker");
      throw Error("admitted");
    } catch (error) {
      expect(error).toMatchObject({
        critical: true,
        message: expect.stringContaining("persistence failed"),
      });
    }
  });
  it("checks quarantine again after slow probes", () => {
    let denied: string | null = null;
    const budget = make(10, {
      quarantine: () => denied,
      sample: () => {
        denied = "concurrent stop";
        return s;
      },
    });
    expect(() => budget.reserve(512, "worker")).toThrow("concurrent stop");
    expect(records()).toHaveLength(0);
  });
  it("fails closed on corrupt metadata and lock contention", () => {
    fs.writeFileSync(path.join(root, "interrupted.json.tmp"), "partial");
    expect(() => make().reserve(512, "worker")).toThrow("interrupted");
    fs.unlinkSync(path.join(root, "interrupted.json.tmp"));
    fs.writeFileSync(path.join(root, "corrupt.json"), "bad");
    expect(() => make().reserve(512, "worker")).toThrow("unverified");
    fs.unlinkSync(path.join(root, "corrupt.json"));
    const release = lockfile.lockSync(path.join(root, "admission"), {
      realpath: false,
    });
    try {
      expect(() => make().reserve(512, "worker")).toThrow("busy");
    } finally {
      release();
    }
  });
  it("rejects stale, partial or forward-clock samples", () => {
    expect(() => assertResourceSnapshot(s, 200, 2048, 6001)).toThrow("stale");
    expect(() => assertResourceSnapshot(s, 200, 2048, 999)).toThrow("stale");
    s.aggregateFootprintMb = null;
    expect(() => make().reserve(512, "worker")).toThrow("unknown aggregate");
  });
  it("does not pretend unsupported platforms provided a footprint", () => {
    const budget = make(10, {
      platform: "linux",
      sample: () => {
        throw Error("must not probe");
      },
    });
    expect(budget.check()).toBeNull();
    budget.reserve(512, "worker").release();
    expect(records()).toHaveLength(0);
  });
  it("invalid budgets cannot disable or inflate the limit", () => {
    for (const raw of ["0", "-1", "NaN", "6145"])
      expect(() => resolveResourceBudgetMb(raw)).toThrow("budget");
    expect(resolveResourceBudgetMb("1024")).toBe(1024);
  });
  it("keeps registration available under warning but requires old MCP clients to reconnect", () => {
    s.processes[1].role = "mcp";
    expect(() => make().reserve(512, "worker")).toThrow("need to reconnect");
    s.memoryPressure = "warn";
    const client = make(20).registerClient();
    expect(records()).toHaveLength(1);
    expect(latch).not.toHaveBeenCalled();
    s.memoryPressure = "normal";
    expect(() => make().reserve(512, "worker")).not.toThrow();
    client.release();
  });
  it("existing inference admission never seeds, locks, prunes or latches", () => {
    expect(make().checkExisting()).toEqual(s);
    expect(fs.readdirSync(root)).toEqual([]);
    s.memoryPressure = "critical";
    expect(() => make().checkExisting()).toThrow("critical");
    expect(latch).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
    s.memoryPressure = "normal";
    fs.writeFileSync(path.join(root, "interrupted.tmp"), "partial");
    expect(() => make().checkExisting()).toThrow("interrupted");
    expect(fs.readFileSync(path.join(root, "interrupted.tmp"), "utf8")).toBe(
      "partial",
    );
  });
  it.each(["warn", "unknown"] as const)(
    "existing critical-only inference admits %s without aggregate sampling or ledger creation",
    (pressure) => {
      fs.rmSync(root, { recursive: true });
      s.memoryPressure = pressure;
      s.kernelPressure = pressure;
      s.aggregateFootprintMb = null;
      s.incompleteReasons = ["aggregate admission disabled"];
      const sample = vi.fn(() => {
        throw new Error("must not sample aggregate resources");
      });
      const criticalSample = vi.fn(() => s);
      const budget = make(10, {
        policy: () => "critical-only",
        sample,
        criticalSample,
      });
      expect(budget.checkExisting()).toBe(s);
      expect(criticalSample).toHaveBeenCalledOnce();
      expect(sample).not.toHaveBeenCalled();
      expect(fs.existsSync(root)).toBe(false);
      expect(latch).not.toHaveBeenCalled();
    },
  );
  it.each(["memoryPressure", "kernelPressure"] as const)(
    "existing critical-only inference refuses critical %s without latching or ledger mutation",
    (key) => {
      s[key] = "critical";
      const budget = make(10, {
        policy: () => "critical-only",
        criticalSample: () => s,
      });
      expect(() => budget.checkExisting()).toThrow("critical host pressure");
      expect(latch).not.toHaveBeenCalled();
      expect(fs.readdirSync(root)).toEqual([]);
    },
  );
  it("existing critical-only inference checks containment before and after sampling", () => {
    let denied: string | null = "existing stop";
    const criticalSample = vi.fn(() => {
      denied = "concurrent stop";
      return s;
    });
    const budget = make(10, {
      policy: () => "critical-only",
      criticalSample,
      quarantine: () => denied,
    });
    expect(() => budget.checkExisting()).toThrow("host containment");
    expect(criticalSample).not.toHaveBeenCalled();
    denied = null;
    expect(() => budget.checkExisting()).toThrow("host containment");
    expect(criticalSample).toHaveBeenCalledOnce();
    expect(latch).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("existing strict inference still refuses warning pressure", () => {
    s.memoryPressure = "warn";
    expect(() => make().checkExisting()).toThrow("warning");
    expect(latch).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("existing admission refuses a symlinked ledger without changing either directory", () => {
    const target = path.join(root, "actual");
    fs.mkdirSync(target);
    const link = path.join(root, "link");
    fs.symlinkSync(target, link);
    expect(() => make(10, { root: link }).checkExisting()).toThrow(
      "unverified resource budget directory",
    );
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(latch).not.toHaveBeenCalled();
  });
  it("existing admission refuses unknown aggregate and concurrent quarantine", () => {
    s.aggregateFootprintMb = null;
    expect(() => make().checkExisting()).toThrow("unknown aggregate");
    s = snapshot();
    let denied: string | null = null;
    const budget = make(10, {
      quarantine: () => denied,
      sample: () => {
        denied = "concurrent hold";
        return s;
      },
    });
    expect(() => budget.checkExisting()).toThrow("containment");
    expect(latch).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
