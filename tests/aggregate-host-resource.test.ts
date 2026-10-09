import { describe, expect, it, vi } from "vitest";

vi.unmock("../src/lib/utils/host-resource");

import {
  parseBatchFootprints,
  parseResourceProcesses,
  sampleHostResources,
} from "../src/lib/utils/host-resource";

const stamp = "Tue Oct  6 23:00:00 2026";
const row = (
  pid: number,
  ppid: number,
  command: string,
  uid = 501,
  pgid = pid,
) => `${uid} ${pid} ${ppid} ${pgid} ${stamp} ${command}`;
const inventory = [
  row(10, 1, "gmax-daemon"),
  row(20, 1, "gmax-mcp"),
  row(30, 10, "/usr/bin/uv"),
  row(40, 30, "/usr/bin/python3"),
  row(50, 20, "node"),
  row(60, 1, "unrelated"),
  row(70, 1, "gmax-mcp", 502),
].join("\n");
function deps() {
  return {
    platform: "darwin",
    pid: 10,
    uid: 501,
    now: () => 1000,
    monotonic: () => 0,
    freeBytes: () => 4096 * 1048576,
    processAlive: () => true,
    run: vi.fn((command: string, args: string[], _timeoutMs?: number) => {
      if (command === "ps") return inventory;
      if (command === "footprint")
        return [10, 20, 30, 40, 50]
          .map((pid) => `node [${pid}]: 64-bit Footprint: 100 MB`)
          .join("\n");
      if (command === "zprint")
        return "data.kalloc.1024 1024 0K 0K 0 0 1000 0K 0";
      if (args[1] === "vm.swapusage") return "used = 1.5G";
      return "1";
    }),
  };
}
describe("bounded aggregate footprint sampling", () => {
  it("allows recovery probes longer than 500ms without extending the total deadline", () => {
    const d = deps();
    const original = d.run.getMockImplementation()!;
    let elapsed = 0;
    d.monotonic = () => elapsed;
    d.run.mockImplementation((command, args, timeout = 0) => {
      if (command === "ps") {
        elapsed += Math.min(600, timeout);
        if (timeout < 600)
          throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      }
      return original(command, args, timeout);
    });
    expect(sampleHostResources([], d).aggregateFootprintMb).toBeNull();
    elapsed = 0;
    d.run.mockClear();
    expect(
      sampleHostResources([], {
        ...d,
        sampleTimeoutMs: 8000,
        commandProbeTimeoutMs: 1500,
        footprintProbeTimeoutMs: 3000,
      }).aggregateFootprintMb,
    ).toBe(500);
    expect(
      d.run.mock.calls.filter(([c]) => c === "ps").map((call) => call[2]),
    ).toEqual([1500, 1500]);
    elapsed = 0;
    d.run.mockClear();
    expect(
      sampleHostResources([], {
        ...d,
        sampleTimeoutMs: 700,
        commandProbeTimeoutMs: 1500,
      }).aggregateFootprintMb,
    ).toBeNull();
    expect(
      d.run.mock.calls.filter(([c]) => c === "ps").map((call) => call[2]),
    ).toEqual([700, 100]);
    expect(elapsed).toBe(700);
  });
  it("includes all clients and recursive children, excluding unrelated/other-user processes", () => {
    expect(
      parseResourceProcesses(inventory, 501, 10).map((p) => [p.pid, p.role]),
    ).toEqual([
      [10, "daemon"],
      [20, "mcp"],
      [30, "helper"],
      [40, "helper"],
      [50, "helper"],
    ]);
  });
  it("excludes the inventory probe itself, which exits before footprint sampling", () => {
    expect(
      parseResourceProcesses(
        `${inventory}\n${row(80, 10, "/bin/ps")}`,
        501,
        10,
      ).map((p) => p.pid),
    ).not.toContain(80);
  });
  it("accepts signed system UIDs without treating those processes as ours", () => {
    expect(
      parseResourceProcesses(
        `${inventory}\n${row(81, 1, "/usr/libexec/dhcp6d", -2)}`,
        501,
        10,
      ).map((p) => p.pid),
    ).not.toContain(81);
  });
  it("includes adopted roots and orphan members of a reserved process group", () => {
    const ps = `${inventory}\n${row(80, 1, "python3", 501, 80)}\n${row(90, 1, "python3", 501, 100)}`;
    expect(
      parseResourceProcesses(ps, 501, 10, [80], [100]).map((p) => p.pid),
    ).toContain(90);
    expect(
      parseResourceProcesses(ps, 501, 10, [80]).find((p) => p.pid === 80)?.role,
    ).toBe("embedding");
  });
  it("samples 5 processes in one footprint command and never substitutes RSS", () => {
    const d = deps();
    const snapshot = sampleHostResources([], d);
    expect(snapshot.aggregateFootprintMb).toBe(500);
    expect(snapshot.swapUsedMb).toBe(1536);
    expect(snapshot.kernelBytes).toBe(1024000);
    expect(snapshot.incompleteReasons).toEqual([]);
    expect(d.run.mock.calls.filter(([c]) => c === "footprint")).toHaveLength(1);
  });
  it("remeasures the full cohort once when a process disappears or changes identity", () => {
    for (const ps of [
      inventory
        .split("\n")
        .filter((line) => line !== row(20, 1, "gmax-mcp"))
        .join("\n"),
      inventory.replace(stamp, "Tue Oct  6 23:01:00 2026"),
    ]) {
      const d = deps();
      let count = 0;
      const original = d.run.getMockImplementation()!;
      d.run.mockImplementation((c, a) =>
        c === "ps" && ++count > 1 ? ps.trim() : original(c, a),
      );
      const s = sampleHostResources([], d);
      expect(s.aggregateFootprintMb).not.toBeNull();
      expect(s.incompleteReasons).toEqual([]);
      expect(d.run.mock.calls.filter(([c]) => c === "ps")).toHaveLength(4);
    }
  });
  it("refuses continuously changing cohorts rather than accepting a partial total", () => {
    const d = deps();
    const original = d.run.getMockImplementation()!;
    let count = 0;
    d.run.mockImplementation((c, a) =>
      c === "ps" && ++count % 2 === 0
        ? inventory
            .split("\n")
            .filter((line) => line !== row(20, 1, "gmax-mcp"))
            .join("\n")
        : original(c, a),
    );
    const s = sampleHostResources([], d);
    expect(s.aggregateFootprintMb).toBeNull();
    expect(s.incompleteReasons).toContain(
      "process inventory changed during sample",
    );
    expect(d.run.mock.calls.filter(([c]) => c === "ps")).toHaveLength(4);
  });
  it("accepts measured survivors when a vanished child is verified dead", () => {
    const d = deps();
    const original = d.run.getMockImplementation()!;
    let count = 0;
    d.processAlive = vi.fn(() => false);
    d.run.mockImplementation((c, a) => {
      if (c === "ps" && ++count > 1)
        return inventory
          .split("\n")
          .filter((line) => line !== row(40, 30, "/usr/bin/python3"))
          .join("\n");
      if (c === "footprint")
        return [10, 20, 30, 50]
          .map((pid) => `node [${pid}]: Footprint: 100 MB`)
          .join("\n");
      return original(c, a);
    });
    const s = sampleHostResources([], d);
    expect(s.aggregateFootprintMb).toBe(400);
    expect(s.processes.map((p) => p.pid)).not.toContain(40);
    expect(s.incompleteReasons).toEqual([]);
    expect(d.processAlive).toHaveBeenCalledWith(40);
    expect(d.run.mock.calls.filter(([c]) => c === "ps")).toHaveLength(2);
  });
  it("refuses to discount an exit whose liveness check is unavailable", () => {
    const d = deps();
    const original = d.run.getMockImplementation()!;
    let count = 0;
    d.processAlive = () => {
      throw Error("process liveness unavailable");
    };
    d.run.mockImplementation((c, a) =>
      c === "ps" && ++count > 1
        ? inventory
            .split("\n")
            .filter((line) => line !== row(40, 30, "/usr/bin/python3"))
            .join("\n")
        : original(c, a),
    );
    const s = sampleHostResources([], d);
    expect(s.aggregateFootprintMb).toBeNull();
    expect(s.incompleteReasons).toContain("process liveness unavailable");
  });
  it.each(["2", "4"])(
    "does not retry away observed pressure flag %s",
    (flag) => {
      const d = deps();
      const original = d.run.getMockImplementation()!;
      let count = 0;
      d.run.mockImplementation((c, a) => {
        if (c === "sysctl" && a[1] === "kern.memorystatus_vm_pressure_level")
          return flag;
        if (c === "ps" && ++count > 1)
          return inventory
            .split("\n")
            .filter((line) => line !== row(20, 1, "gmax-mcp"))
            .join("\n");
        return original(c, a);
      });
      const s = sampleHostResources([], d);
      expect(s.memoryPressure).toBe(flag === "2" ? "warn" : "critical");
      expect(s.aggregateFootprintMb).toBeNull();
      expect(d.run.mock.calls.filter(([c]) => c === "ps")).toHaveLength(2);
    },
  );
  it("does not report a partial total when one footprint is missing", () => {
    const d = deps();
    const original = d.run.getMockImplementation()!;
    d.run.mockImplementation((c, a) =>
      c === "footprint" ? "node [10]: Footprint: 100 MB" : original(c, a),
    );
    expect(sampleHostResources([], d).aggregateFootprintMb).toBeNull();
  });
  it("shares the original deadline across a cohort retry", () => {
    const d = deps();
    const original = d.run.getMockImplementation()!;
    let elapsed = 0;
    let count = 0;
    d.monotonic = () => elapsed;
    d.run.mockImplementation((c, a, timeoutMs) => {
      elapsed += Math.min(350, timeoutMs ?? 350);
      if (c === "ps" && ++count > 1)
        return inventory.replace(stamp, "Tue Oct 6 23:01:00 2026");
      return original(c, a);
    });
    const s = sampleHostResources([], d);
    expect(elapsed).toBeLessThanOrEqual(3000);
    expect(s.aggregateFootprintMb).toBeNull();
    expect(s.incompleteReasons.length).toBeGreaterThan(0);
  });
  it("uses a single monotonic deadline even if the wall clock changes", () => {
    const d = deps();
    let elapsed = 0;
    d.monotonic = () => elapsed;
    d.now = () => 1000 - elapsed;
    d.run.mockImplementation((_c, _a) => {
      elapsed += 500;
      throw Error("unavailable");
    });
    const s = sampleHostResources([], d);
    expect(elapsed).toBeLessThanOrEqual(3000);
    expect(s.aggregateFootprintMb).toBeNull();
  });
  it("marks failed and unsupported probes explicitly", () => {
    const d = deps();
    d.run.mockImplementation(() => {
      throw Error("denied");
    });
    expect(sampleHostResources([], d).memoryPressure).toBe("unknown");
    expect(
      sampleHostResources([], { ...d, platform: "linux" }).memoryPressure,
    ).toBe("unsupported");
    expect(
      sampleHostResources([], { ...d, platform: "linux" }).aggregateFootprintMb,
    ).toBeNull();
  });
  it("rejects malformed inventories, duplicate footprints and excessive clients", () => {
    expect(() => parseResourceProcesses("bad", 501, 10)).toThrow("parsed");
    expect(() =>
      parseResourceProcesses(
        Array.from({ length: 65 }, (_, i) => row(i + 10, 1, "gmax-mcp")).join(
          "\n",
        ),
        501,
        10,
      ),
    ).toThrow("64");
    expect(() =>
      parseBatchFootprints(
        "node [10]: Footprint: 1 GB\nnode [10]: Footprint: 100 MB",
      ),
    ).toThrow("invalid");
    expect(parseBatchFootprints("node [10]: Footprint: 1.5 GB").get(10)).toBe(
      1536,
    );
  });
});
