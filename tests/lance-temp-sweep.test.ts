import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STALE_TEMP_FILE_AGE_MS } from "../src/config";
import {
  findStaleLanceTempFiles,
  sweepStaleLanceTempFiles,
} from "../src/lib/store/vector-db";

const HOUR_MS = 60 * 60 * 1000;

describe("abandoned Lance temp file sweep", () => {
  let root: string;
  let lancedbDir: string;
  let dataDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-temp-sweep-"));
    lancedbDir = path.join(root, "lancedb");
    dataDir = path.join(lancedbDir, "chunks.lance", "data");
    fs.mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(name: string, bytes: number, ageMs: number): string {
    const full = path.join(dataDir, name);
    fs.writeFileSync(full, Buffer.alloc(bytes));
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(full, when, when);
    return full;
  }

  it("finds dot-prefixed temp files older than the age gate", () => {
    write(".tmpOLD", 1024, 5 * HOUR_MS);

    const found = findStaleLanceTempFiles(lancedbDir);

    expect(found).toHaveLength(1);
    expect(found[0].path).toContain(".tmpOLD");
    expect(found[0].size).toBe(1024);
  });

  it("leaves temp files a live writer could still be staging", () => {
    // An in-flight optimize keeps bumping its temp file's mtime. That recency is
    // the entire safety argument for deleting the rest, so a fresh file must
    // survive even though it looks identical in every other respect.
    write(".tmpFRESH", 1024, 60_000);

    expect(findStaleLanceTempFiles(lancedbDir)).toEqual([]);
    expect(sweepStaleLanceTempFiles(lancedbDir).filesRemoved).toBe(0);
    expect(fs.existsSync(path.join(dataDir, ".tmpFRESH"))).toBe(true);
  });

  it("never touches real fragment files regardless of age", () => {
    const fragment = write("0100abcd.lance", 2048, 90 * 24 * HOUR_MS);

    expect(findStaleLanceTempFiles(lancedbDir)).toEqual([]);
    sweepStaleLanceTempFiles(lancedbDir);
    expect(fs.existsSync(fragment)).toBe(true);
  });

  it("reports bytes actually reclaimed and removes the files", () => {
    write(".tmpA", 4096, 3 * HOUR_MS);
    write(".tmpB", 2048, 3 * HOUR_MS);
    write(".tmpFRESH", 8192, 0);
    const keep = write("0100abcd.lance", 512, 3 * HOUR_MS);

    const result = sweepStaleLanceTempFiles(lancedbDir);

    expect(result.filesRemoved).toBe(2);
    expect(result.bytesFreed).toBe(4096 + 2048);
    expect(fs.existsSync(path.join(dataDir, ".tmpA"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, ".tmpB"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, ".tmpFRESH"))).toBe(true);
    expect(fs.existsSync(keep)).toBe(true);
  });

  it("scans every .lance table directory, not just chunks", () => {
    const otherData = path.join(lancedbDir, "other.lance", "data");
    fs.mkdirSync(otherData, { recursive: true });
    const stale = path.join(otherData, ".tmpOTHER");
    fs.writeFileSync(stale, Buffer.alloc(256));
    const when = new Date(Date.now() - 3 * HOUR_MS);
    fs.utimesSync(stale, when, when);

    expect(findStaleLanceTempFiles(lancedbDir)).toHaveLength(1);
  });

  it("returns empty rather than throwing when the store does not exist", () => {
    expect(findStaleLanceTempFiles(path.join(root, "nope"))).toEqual([]);
    expect(sweepStaleLanceTempFiles(path.join(root, "nope"))).toEqual({
      filesRemoved: 0,
      bytesFreed: 0,
    });
  });

  it("gates on an age well past a realistic optimize run", () => {
    expect(STALE_TEMP_FILE_AGE_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
});
