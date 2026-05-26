import { describe, expect, it } from "vitest";
import { coerceColbertBytes } from "../src/lib/workers/orchestrator";

describe("coerceColbertBytes", () => {
  it("passes Int8Array through", () => {
    const src = new Int8Array([1, -2, 3, -4]);
    expect(coerceColbertBytes(src)).toBe(src);
  });

  it("converts Buffer to Int8Array view", () => {
    const buf = Buffer.from([5, 10, 15, 20]);
    const out = coerceColbertBytes(buf);
    expect(out).toBeInstanceOf(Int8Array);
    expect(Array.from(out)).toEqual([5, 10, 15, 20]);
  });

  it("converts number[] to Int8Array", () => {
    const out = coerceColbertBytes([7, -8, 9]);
    expect(out).toBeInstanceOf(Int8Array);
    expect(Array.from(out)).toEqual([7, -8, 9]);
  });

  it("handles {type:'Buffer', data:[...]} (Node Buffer.toJSON)", () => {
    const out = coerceColbertBytes({ type: "Buffer", data: [11, 12, 13] });
    expect(out).toBeInstanceOf(Int8Array);
    expect(Array.from(out)).toEqual([11, 12, 13]);
  });

  // Regression: Int8Array sent over child_process.send arrives as a plain
  // object with numeric keys. Before the 2026-05-25 fix this branch was
  // missing and the rerank pipeline silently no-op'd.
  it("handles {0:byte, 1:byte, ...} (Int8Array via child_process IPC)", () => {
    const payload = { 0: 30, 1: 25, 2: -5, 3: 0 };
    const out = coerceColbertBytes(payload);
    expect(out).toBeInstanceOf(Int8Array);
    expect(out.length).toBe(4);
    expect(Array.from(out)).toEqual([30, 25, -5, 0]);
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
