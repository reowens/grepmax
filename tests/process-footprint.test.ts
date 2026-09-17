import { describe, expect, it } from "vitest";
import {
  parseFootprintMb,
  readFootprintMb,
} from "../src/lib/utils/process-footprint";

describe("parseFootprintMb", () => {
  it("reads the header line of footprint -p output", () => {
    const output = [
      "======================================================================",
      "node [22835]: 64-bit    Footprint: 4232 MB (16384 bytes per page)",
      "======================================================================",
    ].join("\n");
    expect(parseFootprintMb(output)).toBe(4232);
  });

  it("scales GB and KB", () => {
    expect(parseFootprintMb("x Footprint: 1.5 GB (16384 bytes per page)")).toBe(
      1536,
    );
    expect(parseFootprintMb("x Footprint: 512 KB (16384 bytes per page)")).toBe(
      0.5,
    );
  });

  it("returns null for output it does not recognise", () => {
    expect(parseFootprintMb("")).toBeNull();
    expect(parseFootprintMb("footprint: no such process")).toBeNull();
  });
});

describe("readFootprintMb", () => {
  it("returns a positive number for the current process", () => {
    expect(readFootprintMb()).toBeGreaterThan(0);
  });
});
