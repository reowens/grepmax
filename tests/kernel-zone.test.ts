import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));

import {
  classifyZonePressure,
  formatPressureProbe,
  formatZoneUsage,
  parseZprintOutput,
  probeKernelZoneUsage,
  probeMemoryPressure,
  readKernelZoneUsage,
  ZONE_THRESHOLDS,
} from "../src/lib/utils/kernel-zone";

/** Verbatim `zprint data.kalloc.1024` output from macOS 26.5.2 build 25F84. */
const REAL_OUTPUT = [
  "                            elem         cur         max        cur         max         cur  alloc  alloc    ",
  "zone name                   size        size        size      #elts       #elts       inuse   size  count    ",
  "-------------------------------------------------------------------------------------------------------------",
  "data.kalloc.1024            1024          0K          0K          0           0        3416     0K      0   ",
].join("\n");

describe("readKernelZoneUsage bounded probe", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    mocks.execFileSync.mockReset();
  });
  afterEach(() => Object.defineProperty(process, "platform", platform));

  it("bounds a successful probe with scheduling margin and capped output", () => {
    mocks.execFileSync.mockReturnValue(REAL_OUTPUT);
    expect(readKernelZoneUsage()).toMatchObject({
      elements: 3416,
      pressure: "ok",
    });
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "zprint",
      ["-L", "data.kalloc.1024"],
      {
        encoding: "utf-8",
        timeout: 5000,
        maxBuffer: 65536,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  });
  it("returns unknown on timeout without retrying or assuming healthy", () => {
    mocks.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    });
    expect(readKernelZoneUsage()).toBeNull();
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
  });
  it("returns unknown for an unparseable report", () => {
    mocks.execFileSync.mockReturnValue("unrecognized output");
    expect(readKernelZoneUsage()).toBeNull();
  });
  it("does not launch a probe on unsupported platforms", () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    expect(readKernelZoneUsage()).toBeNull();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });
});

describe("typed pressure probe diagnostics", () => {
  const injected = (run = vi.fn(() => REAL_OUTPUT)) => {
    let elapsed = 10;
    return {
      platform: "darwin",
      wallNow: () => 1_700_000_000_000,
      monotonicNow: () => {
        const now = elapsed;
        elapsed += 1584;
        return now;
      },
      run,
    };
  };

  it("records successful kernel timing, output bytes and usage", () => {
    const deps = injected();
    expect(probeKernelZoneUsage(undefined, deps)).toMatchObject({
      status: "known",
      sampledAtMs: 1_700_000_000_000,
      durationMs: 1584,
      outputBytes: Buffer.byteLength(REAL_OUTPUT),
      usage: { elements: 3416, elementSize: 1024, pressure: "ok" },
    });
    expect(deps.run).toHaveBeenCalledWith(
      "zprint",
      ["-L", "data.kalloc.1024"],
      expect.objectContaining({ timeout: 5000, maxBuffer: 65536 }),
    );
  });

  it.each([
    ["ETIMEDOUT", "timeout"],
    ["ENOBUFS", "output-limit"],
    ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "output-limit"],
    ["EACCES", "execution"],
  ])("distinguishes %s without retaining raw output/errors", (code, reason) => {
    const run = vi.fn((): string => {
      throw Object.assign(new Error("secret diagnostic"), {
        code,
        stdout: Buffer.from("secret-output"),
        stderr: "secret-error",
      });
    });
    const result = probeKernelZoneUsage(undefined, injected(run));
    expect(result).toMatchObject({
      status: "unknown",
      reason,
      errorCode: code,
      outputBytes: 13,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(run).toHaveBeenCalledOnce();
  });

  it("records sanitized exits and excludes arbitrary code/signal strings", () => {
    const run = vi.fn((): string => {
      throw { code: "secret", status: 3, signal: "secret", stdout: "abc" };
    });
    expect(probeKernelZoneUsage(undefined, injected(run))).toMatchObject({
      status: "unknown",
      reason: "exit",
      errorCode: "UNKNOWN",
      exitCode: 3,
      signal: null,
      outputBytes: 3,
    });
  });

  it("records known termination signals without interpreting them as healthy", () => {
    const run = vi.fn((): string => {
      throw { status: null, signal: "SIGTERM" };
    });
    expect(probeKernelZoneUsage(undefined, injected(run))).toMatchObject({
      status: "unknown",
      reason: "exit",
      signal: "SIGTERM",
    });
  });

  it.each([
    "garbled",
    "data.kalloc.1024 1024 0K 0K 0 0 99999999999999999 0K 0",
  ])("records malformed/unsafe kernel reports as parse failures", (output) => {
    expect(
      probeKernelZoneUsage(undefined, injected(vi.fn(() => output))),
    ).toMatchObject({
      status: "unknown",
      reason: "parse",
      outputBytes: Buffer.byteLength(output),
      errorCode: null,
    });
  });

  it("does not execute either probe on unsupported hosts", () => {
    const deps = { ...injected(), platform: "linux" };
    expect(probeKernelZoneUsage(undefined, deps)).toMatchObject({
      status: "unsupported",
      reason: "unsupported-platform",
      outputBytes: 0,
    });
    expect(probeMemoryPressure(deps)).toMatchObject({ status: "unsupported" });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each([
    ["1\n", "normal"],
    ["2", "warn"],
    ["4", "critical"],
  ])("maps only documented dispatch flag %s to %s", (output, pressure) => {
    const deps = injected(vi.fn(() => output));
    expect(probeMemoryPressure(deps)).toMatchObject({
      status: "known",
      pressure,
      level: Number(output.trim()),
      outputBytes: Buffer.byteLength(output),
    });
    expect(deps.run).toHaveBeenCalledWith(
      "sysctl",
      ["-n", "kern.memorystatus_vm_pressure_level"],
      expect.objectContaining({ timeout: 1000, maxBuffer: 65536 }),
    );
  });

  it.each(["0", "3", "5", "normal", "1 extra", ""])(
    "refuses unknown memory pressure %s",
    (output) => {
      expect(probeMemoryPressure(injected(vi.fn(() => output)))).toMatchObject({
        status: "unknown",
        reason: "parse",
      });
    },
  );

  it("reports a sysctl timeout instead of a normal pressure", () => {
    const run = vi.fn((): string => {
      throw { code: "ETIMEDOUT", signal: "SIGTERM" };
    });
    expect(probeMemoryPressure(injected(run))).toMatchObject({
      status: "unknown",
      reason: "timeout",
      signal: "SIGTERM",
    });
  });

  it("formats only bounded scalar diagnostic metadata", () => {
    const run = vi.fn((): string => {
      throw Object.assign(new Error("secret"), {
        code: "ETIMEDOUT",
        signal: "SIGTERM",
        stdout: "secret",
      });
    });
    const result = probeKernelZoneUsage(undefined, injected(run));
    expect(JSON.parse(formatPressureProbe(result))).toEqual({
      status: "unknown",
      sampledAtMs: 1_700_000_000_000,
      durationMs: 1584,
      outputBytes: 6,
      reason: "timeout",
      errorCode: "ETIMEDOUT",
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(formatPressureProbe(result)).not.toContain("secret");
    expect(
      JSON.parse(
        formatPressureProbe(probeMemoryPressure(injected(vi.fn(() => "1")))),
      ),
    ).toMatchObject({ status: "known", durationMs: 1584, outputBytes: 1 });
  });
});

describe("parseZprintOutput", () => {
  it("reads element count and size from a real report", () => {
    expect(parseZprintOutput(REAL_OUTPUT)).toEqual({
      elements: 3416,
      elementSize: 1024,
    });
  });

  it("ignores similarly named zones", () => {
    const output = [
      "data_shared.kalloc.1024     1024          0K          0K          0           0           3     0K      0",
      "early.kalloc.1024           1024          0K          0K          0           0          96     0K      0",
      "data.kalloc.1024            1024          0K          0K          0           0        7777     0K      0",
      "kalloc.1024                 1024          0K          0K          0           0        1123     0K      0",
    ].join("\n");
    expect(parseZprintOutput(output)?.elements).toBe(7777);
  });

  it("returns null when the zone is absent", () => {
    expect(parseZprintOutput("zone name  size\nvm.pages  64  1")).toBeNull();
  });

  it("returns null rather than guessing when the layout changes", () => {
    // An unknown format must read as "no sample", never as a healthy zero —
    // a false 'ok' is the one failure mode that gets the host panicked.
    expect(
      parseZprintOutput("data.kalloc.1024 lots of new columns"),
    ).toBeNull();
    expect(parseZprintOutput("data.kalloc.1024")).toBeNull();
    expect(parseZprintOutput("data.kalloc.1024 1024 0K 0K 0 0 -5 0K 0")).toBe(
      null,
    );
  });

  it("handles an empty report", () => {
    expect(parseZprintOutput("")).toBeNull();
  });
});

describe("classifyZonePressure", () => {
  const GIB = 1024 ** 3;

  it("treats observed healthy readings as ok", () => {
    // Twelve days of ordinary use held the zone in this band.
    expect(classifyZonePressure(0.67 * GIB)).toBe("ok");
    expect(classifyZonePressure(1.37 * GIB)).toBe("ok");
  });

  it("warns before the burst gets far", () => {
    expect(classifyZonePressure(4 * GIB)).toBe("warn");
    expect(classifyZonePressure(7.9 * GIB)).toBe("warn");
  });

  it("goes critical with headroom left", () => {
    expect(classifyZonePressure(8 * GIB)).toBe("critical");
    // The reading 6 hours before panic 3.
    expect(classifyZonePressure(17.89 * GIB)).toBe("critical");
  });

  it("stays well under the observed ~17.6GiB zone map cap", () => {
    expect(ZONE_THRESHOLDS.criticalBytes).toBeLessThan(9 * GIB);
    expect(ZONE_THRESHOLDS.warnBytes).toBeLessThan(
      ZONE_THRESHOLDS.criticalBytes,
    );
  });
});

describe("formatZoneUsage", () => {
  it("reports GiB and element count", () => {
    const text = formatZoneUsage({
      elements: 20_988_560,
      elementSize: 1024,
      bytes: 20_988_560 * 1024,
      pressure: "critical",
    });
    expect(text).toContain("data.kalloc.1024");
    expect(text).toContain("20.02GiB");
    expect(text).toContain("20,988,560");
  });
});
