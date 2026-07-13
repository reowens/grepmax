import { describe, expect, it } from "vitest";
import {
  CURRENT_META_HASH_VERSION,
  isMetaEntryCacheCurrent,
  reconcileMetaEntry,
} from "../src/lib/index/cache-coherence";
import type { MetaEntry } from "../src/lib/store/meta-cache";

function entry(overrides: Partial<MetaEntry> = {}): MetaEntry {
  return {
    hash: "hash",
    mtimeMs: 1,
    size: 10,
    ...overrides,
  };
}

describe("reconcileMetaEntry", () => {
  it("stamps legacy non-Markdown metadata when vectors exist", () => {
    const result = reconcileMetaEntry("/repo/source.ts", entry(), true);
    expect(result).toEqual({
      action: "stamp",
      entry: entry({
        hashVersion: CURRENT_META_HASH_VERSION,
        hasVectors: true,
      }),
    });
  });

  it("reprocesses legacy Markdown because its old hash omitted frontmatter", () => {
    expect(reconcileMetaEntry("/repo/readme.md", entry(), true)).toEqual({
      action: "reprocess",
      mustRewriteVectors: false,
    });
  });

  it("reprocesses an explicit unknown hash version instead of relabeling it", () => {
    expect(
      reconcileMetaEntry(
        "/repo/source.ts",
        entry({ hashVersion: CURRENT_META_HASH_VERSION + 1, hasVectors: true }),
        true,
      ),
    ).toEqual({ action: "reprocess", mustRewriteVectors: false });
  });

  it("reprocesses a legacy vectorless entry to classify its intent", () => {
    expect(reconcileMetaEntry("/repo/source.ts", entry(), false)).toEqual({
      action: "reprocess",
      mustRewriteVectors: true,
    });
  });

  it("accepts explicit vector and tombstone states when physical rows agree", () => {
    expect(
      reconcileMetaEntry(
        "/repo/source.ts",
        entry({ hashVersion: CURRENT_META_HASH_VERSION, hasVectors: true }),
        true,
      ),
    ).toEqual({ action: "current" });
    expect(
      reconcileMetaEntry(
        "/repo/empty.ts",
        entry({ hashVersion: CURRENT_META_HASH_VERSION, hasVectors: false }),
        false,
      ),
    ).toEqual({ action: "current" });
  });

  it("reprocesses both missing expected vectors and unexpected vectors", () => {
    expect(
      reconcileMetaEntry(
        "/repo/missing.ts",
        entry({ hashVersion: CURRENT_META_HASH_VERSION, hasVectors: true }),
        false,
      ),
    ).toEqual({ action: "reprocess", mustRewriteVectors: true });
    expect(
      reconcileMetaEntry(
        "/repo/tombstone.ts",
        entry({ hashVersion: CURRENT_META_HASH_VERSION, hasVectors: false }),
        true,
      ),
    ).toEqual({ action: "reprocess", mustRewriteVectors: true });
  });

  it("treats vector-only paths as requiring authoritative replacement", () => {
    expect(reconcileMetaEntry("/repo/orphan.ts", undefined, true)).toEqual({
      action: "reprocess",
      mustRewriteVectors: true,
    });
  });
});

describe("isMetaEntryCacheCurrent", () => {
  it("requires the current hash version and explicit vector state", () => {
    expect(isMetaEntryCacheCurrent(entry(), "/repo/source.ts")).toBe(false);
    expect(
      isMetaEntryCacheCurrent(
        entry({ hashVersion: CURRENT_META_HASH_VERSION, hasVectors: true }),
        "/repo/source.ts",
      ),
    ).toBe(true);
  });
});
