import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  denied: false,
  diskDenied: false,
  db: {
    get: vi.fn(),
    getRange: vi.fn(() => []),
    put: vi.fn(),
    remove: vi.fn(),
    close: vi.fn(),
    flushed: Promise.resolve(),
  },
  open: vi.fn(),
}));
vi.mock("lmdb", () => ({ open: h.open }));
vi.mock("../src/lib/store/maintenance-policy", () => ({
  assertFreshDiskMutationAllowed: () => {
    if (h.diskDenied) throw new Error("disk space unknown");
    return 100 * 1024 ** 3;
  },
  storeMutationDeniedReason: () => (h.denied ? "quarantined" : null),
  assertStoreMutationAllowed: () => {
    if (h.denied) throw new Error("quarantined");
  },
}));
vi.mock("../src/lib/utils/cleanup", () => ({
  registerCleanup: () => () => {},
}));

import { MetaCache } from "../src/lib/store/meta-cache";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-cache-containment-"));
  h.denied = false;
  h.diskDenied = false;
  vi.clearAllMocks();
  h.open.mockReturnValue(h.db);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("metadata cache quarantine", () => {
  it("unknown disk opens existing cache read-only and refuses writes", () => {
    h.diskDenied = true;
    const cache = new MetaCache(root);
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
    );
    expect(() => cache.delete("file")).toThrow("disk space unknown");
    expect(h.db.remove).not.toHaveBeenCalled();
  });
  it("fresh disk failure stops an already-open writer", () => {
    const cache = new MetaCache(root);
    h.diskDenied = true;
    expect(() =>
      cache.put("file", { hash: "new", mtimeMs: 0, size: 0 }),
    ).toThrow("disk space unknown");
    expect(h.db.put).not.toHaveBeenCalled();
  });
  it("opens existing cache read-only and retains reads", async () => {
    h.denied = true;
    h.db.get.mockReturnValue({ hash: "existing" });
    const cache = new MetaCache(root);
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
    );
    expect(cache.get("file")).toEqual({ hash: "existing" });
    expect(() =>
      cache.put("file", { hash: "new", mtimeMs: 0, size: 0 }),
    ).toThrow("quarantined");
    expect(() => cache.delete("file")).toThrow("quarantined");
    expect(h.db.put).not.toHaveBeenCalled();
    expect(h.db.remove).not.toHaveBeenCalled();
    await cache.close();
  });
  it("refuses missing cache without creating directories or opening LMDB", () => {
    h.denied = true;
    const missing = path.join(root, "missing", "cache");
    expect(() => new MetaCache(missing)).toThrow("quarantined");
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
    expect(h.open).not.toHaveBeenCalled();
  });
  it("cannot turn a read-only instance writable when quarantine clears", () => {
    h.denied = true;
    const cache = new MetaCache(root);
    h.denied = false;
    expect(() => cache.delete("file")).toThrow("read-only");
    expect(h.db.remove).not.toHaveBeenCalled();
  });
  it("stops an already-open writer when containment appears", () => {
    const cache = new MetaCache(root);
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: false }),
    );
    h.denied = true;
    expect(() =>
      cache.put("file", { hash: "new", mtimeMs: 0, size: 0 }),
    ).toThrow("quarantined");
    expect(h.db.put).not.toHaveBeenCalled();
  });
});
