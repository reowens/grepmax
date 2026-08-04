import { describe, expect, it } from "vitest";
import { coerceColbertBytes } from "../src/lib/workers/orchestrator";

describe("coerceColbertBytes", () => {
  it("passes Int8Array through", () => {
    const src = new Int8Array([1, -2, 3, -4]);
    expect(coerceColbertBytes(src)).toBe(src);
  });

  it("reinterprets Buffer as an Int8Array view", () => {
    const buf = Buffer.from([5, 10, 15, 20]);
    const out = coerceColbertBytes(buf);
    expect(out).toBeInstanceOf(Int8Array);
    expect(Array.from(out)).toEqual([5, 10, 15, 20]);
  });

  it("reinterprets a Uint8Array subarray with its byte range and signed values", () => {
    const backing = new Uint8Array([99, 100, 5, 200, 15, 20, 101]);
    const src = backing.subarray(2, 6);

    const out = coerceColbertBytes(src);

    expect(out).toBeInstanceOf(Int8Array);
    expect(out.buffer).toBe(src.buffer);
    expect(out.byteOffset).toBe(src.byteOffset);
    expect(out.byteLength).toBe(src.byteLength);
    expect(Array.from(out)).toEqual([5, -56, 15, 20]);
  });

  it("converts number[] to Int8Array", () => {
    const out = coerceColbertBytes([7, -8, 9]);
    expect(out).toBeInstanceOf(Int8Array);
    expect(Array.from(out)).toEqual([7, -8, 9]);
  });

  it("returns empty Int8Array for null/undefined", () => {
    expect(coerceColbertBytes(null).length).toBe(0);
    expect(coerceColbertBytes(undefined).length).toBe(0);
  });

  it("returns empty Int8Array for a plain object with non-numeric keys", () => {
    expect(coerceColbertBytes({ foo: 1, bar: 2 }).length).toBe(0);
  });

  it("returns empty Int8Array for empty object {}", () => {
    expect(coerceColbertBytes({}).length).toBe(0);
  });
});
