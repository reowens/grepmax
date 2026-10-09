import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ memory: vi.fn(), kernel: vi.fn() }));
vi.mock("../src/lib/utils/kernel-zone", () => ({
  probeMemoryPressure: h.memory,
  probeKernelZoneUsage: h.kernel,
}));

import { sampleCriticalPressure } from "../src/lib/utils/host-guard-policy";

describe("critical-only trigger sampling", () => {
  beforeEach(() => {
    h.memory.mockReset();
    h.kernel.mockReset();
    h.kernel.mockReturnValue({
      status: "known",
      sampledAtMs: 110,
      durationMs: 5,
      outputBytes: 40,
      usage: { pressure: "ok", bytes: 1024, elements: 1, elementSize: 1024 },
    });
  });
  it("retains an initial critical sample even if the refreshed OS probe is normal", () => {
    const initial = {
      status: "known",
      pressure: "critical",
      level: 4,
      sampledAtMs: 100,
      durationMs: 2,
      outputBytes: 2,
    };
    const final = {
      status: "known",
      pressure: "normal",
      level: 1,
      sampledAtMs: 120,
      durationMs: 2,
      outputBytes: 2,
    };
    h.memory.mockReturnValueOnce(initial).mockReturnValueOnce(final);
    const sample = sampleCriticalPressure();
    expect(sample.memoryPressure).toBe("critical");
    expect(sample.pressureProbes).toEqual({
      memoryInitial: initial,
      kernel: h.kernel.mock.results[0].value,
      memoryFinal: final,
    });
    expect(h.memory).toHaveBeenCalledTimes(2);
    expect(h.kernel).toHaveBeenCalledOnce();
  });
  it("keeps known kernel-critical evidence with an unknown OS probe", () => {
    h.memory.mockReturnValue({
      status: "unknown",
      reason: "timeout",
      sampledAtMs: 100,
      durationMs: 1000,
      outputBytes: 0,
    });
    const kernel = {
      status: "known",
      sampledAtMs: 110,
      durationMs: 5,
      outputBytes: 40,
      usage: {
        pressure: "critical",
        bytes: 9 * 1024 ** 3,
        elements: 9437184,
        elementSize: 1024,
      },
    };
    h.kernel.mockReturnValue(kernel);
    const sample = sampleCriticalPressure();
    expect(sample.memoryPressure).toBe("unknown");
    expect(sample.kernelPressure).toBe("critical");
    expect(sample.pressureProbes?.kernel).toBe(kernel);
    expect(sample.kernelBytes).toBe(kernel.usage.bytes);
    expect(sample.pressureProbes?.memoryInitial?.status).toBe("unknown");
  });
});
