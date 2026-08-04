import { describe, expect, it } from "vitest";
import { WATCHER_IGNORE_GLOBS } from "../src/lib/index/watcher";

describe("watcher ignore globs", () => {
  it("covers ignored directories at any depth (dir entry + contents)", () => {
    expect(WATCHER_IGNORE_GLOBS).toContain("**/node_modules");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/node_modules/**");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/dist");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/dist/**");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/.git/**");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/.gmax/**");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/.turbo/**");
  });

  it("contains no bare directory names (parcel treats non-globs as root-relative paths)", () => {
    // A non-glob entry is resolved via path.resolve(root, entry) and only
    // matches at the top level — nested packages/*/dist would leak through.
    for (const pattern of WATCHER_IGNORE_GLOBS) {
      expect(pattern).toMatch(/[*?{[]/);
    }
  });

  it("does not ignore dotfiles wholesale", () => {
    expect(WATCHER_IGNORE_GLOBS).not.toContain(".*");
    expect(WATCHER_IGNORE_GLOBS).not.toContain("**/.*");
    expect(WATCHER_IGNORE_GLOBS.some((g) => g.includes(".gitignore"))).toBe(
      false,
    );
    expect(WATCHER_IGNORE_GLOBS.some((g) => g.includes(".gmaxignore"))).toBe(
      false,
    );
  });

  it("keeps editor/Xcode temp-file globs", () => {
    expect(WATCHER_IGNORE_GLOBS).toContain("**/*.tmp.*");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/*.sb-*");
  });
});
