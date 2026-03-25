import { describe, expect, it } from "vitest";
import { isFileCached } from "../src/lib/utils/cache-check";

describe("isFileCached", () => {
  it("returns false when cached is undefined", () => {
    expect(isFileCached(undefined, { mtimeMs: 1000, size: 500 })).toBe(false);
  });

  it("returns false when cached is null", () => {
    expect(isFileCached(null, { mtimeMs: 1000, size: 500 })).toBe(false);
  });

  it("returns true when mtime and size both match", () => {
    const cached = { mtimeMs: 1711123456789, size: 1024 };
    const stats = { mtimeMs: 1711123456789, size: 1024 };
    expect(isFileCached(cached, stats)).toBe(true);
  });

  it("returns false when mtime differs", () => {
    const cached = { mtimeMs: 1711123456789, size: 1024 };
    const stats = { mtimeMs: 1711123456790, size: 1024 };
    expect(isFileCached(cached, stats)).toBe(false);
  });

  it("returns false when size differs", () => {
    const cached = { mtimeMs: 1711123456789, size: 1024 };
    const stats = { mtimeMs: 1711123456789, size: 2048 };
    expect(isFileCached(cached, stats)).toBe(false);
  });

  it("returns false when both differ", () => {
    const cached = { mtimeMs: 1000, size: 500 };
    const stats = { mtimeMs: 2000, size: 600 };
    expect(isFileCached(cached, stats)).toBe(false);
  });

  it("handles floating point mtimeMs from APFS", () => {
    const cached = { mtimeMs: 1711123456789.123, size: 1024 };
    const stats = { mtimeMs: 1711123456789.123, size: 1024 };
    expect(isFileCached(cached, stats)).toBe(true);
  });

  it("treats sub-millisecond mtime differences as equal", () => {
    const cached = { mtimeMs: 1711123456789.123, size: 1024 };
    const stats = { mtimeMs: 1711123456789.456, size: 1024 };
    expect(isFileCached(cached, stats)).toBe(true);
  });

  it("detects real mtime differences across millisecond boundary", () => {
    const cached = { mtimeMs: 1711123456789.9, size: 1024 };
    const stats = { mtimeMs: 1711123456790.1, size: 1024 };
    expect(isFileCached(cached, stats)).toBe(false);
  });
});
