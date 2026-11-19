import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "lmdb";
import { expect, it } from "vitest";
import { MetaCache, type MetaEntry } from "../src/lib/store/meta-cache";

it("reads all metadata keys and stops at the project directory boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "gmax-cache-keys-"));
  const keys = ["/app", "/app-old/x", "/app/a", "/app/nested/b", "/apple/c"];
  try {
    const writer = open<MetaEntry>({ path: root, compression: true });
    try {
      for (const key of keys) {
        await writer.put(key, { hash: key, mtimeMs: 1, size: 1 });
      }
    } finally {
      await writer.close();
    }
    const cache = new MetaCache(root, { readOnly: true });
    try {
      expect(await cache.getAllKeys()).toEqual(new Set(keys));
      expect(await cache.getKeysWithPrefix("/app/")).toEqual(
        new Set(["/app/a", "/app/nested/b"]),
      );
      expect(await cache.getKeysWithPrefix("/absent/")).toEqual(new Set());
    } finally {
      await cache.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
