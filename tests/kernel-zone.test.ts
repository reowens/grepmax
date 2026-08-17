import { describe, expect, it } from "vitest";
import {
  classifyZonePressure,
  formatZoneUsage,
  parseZprintOutput,
  ZONE_THRESHOLDS,
} from "../src/lib/utils/kernel-zone";

/** Verbatim `zprint data.kalloc.1024` output from macOS 26.5.2 build 25F84. */
const REAL_OUTPUT = [
  "                            elem         cur         max        cur         max         cur  alloc  alloc    ",
  "zone name                   size        size        size      #elts       #elts       inuse   size  count    ",
  "-------------------------------------------------------------------------------------------------------------",
  "data.kalloc.1024            1024          0K          0K          0           0        3416     0K      0   ",
].join("\n");

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
