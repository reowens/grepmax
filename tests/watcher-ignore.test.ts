import { describe, expect, it } from "vitest";
import { WATCHER_IGNORE_GLOBS } from "../src/lib/index/watcher";

describe("watcher ignore globs", () => {
  it("contains expected directory patterns", () => {
    expect(WATCHER_IGNORE_GLOBS.length).toBeGreaterThan(0);
    expect(WATCHER_IGNORE_GLOBS).toContain("node_modules");
    expect(WATCHER_IGNORE_GLOBS).toContain(".git");
    expect(WATCHER_IGNORE_GLOBS).toContain(".gmax");
    expect(WATCHER_IGNORE_GLOBS).toContain("dist");
    expect(WATCHER_IGNORE_GLOBS).toContain(".*");
  });

  it("all entries are strings (no regex)", () => {
    for (const pattern of WATCHER_IGNORE_GLOBS) {
      expect(typeof pattern).toBe("string");
    }
  });
});
