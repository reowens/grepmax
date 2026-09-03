import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as watcher from "@parcel/watcher";
import { describe, expect, it } from "vitest";
import { GENERATED_SOURCE_PATTERNS } from "../src/lib/index/ignore-patterns";
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
    // SwiftPM and Xcode build output: 12k+ file writes per build.
    expect(WATCHER_IGNORE_GLOBS).toContain("**/.build/**");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/DerivedData/**");
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

describe("watcher ignore globs: generated source", () => {
  it("ignores codegen output at any depth so it never reaches the FSEvents buffer", () => {
    // Regression: platform's Apollo iOS codegen rewrites ~3,400 *.graphql.swift
    // files per run; the file policy already dropped them, but the watcher
    // still received every event and overflowed ("Events were dropped").
    expect(WATCHER_IGNORE_GLOBS).toContain("**/*.graphql.swift");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/Generated/**");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/__generated__/**");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/*.pb.go");
    expect(WATCHER_IGNORE_GLOBS).toContain("**/gql/graphql.ts");
  });

  it("stays in sync with the file policy's generated-source list", () => {
    for (const p of GENERATED_SOURCE_PATTERNS) {
      const glob = p.startsWith("**/") ? p : `**/${p}`;
      expect(WATCHER_IGNORE_GLOBS).toContain(glob);
    }
  });

  it("delivers events for source files but not for codegen siblings (real @parcel/watcher)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gmax-watch-ignore-"));
    const realRoot = await fs.realpath(root);
    const genDir = path.join(
      realRoot,
      "packages",
      "ios",
      "Sources",
      "Operations",
    );
    const srcDir = path.join(realRoot, "packages", "api", "src");
    await fs.mkdir(genDir, { recursive: true });
    await fs.mkdir(srcDir, { recursive: true });

    const seen: string[] = [];
    const sub = await watcher.subscribe(
      realRoot,
      (err, events) => {
        if (err) throw err;
        for (const e of events) seen.push(e.path);
      },
      { ignore: WATCHER_IGNORE_GLOBS },
    );
    try {
      // Let the subscription settle before writing.
      await new Promise((r) => setTimeout(r, 300));
      await fs.writeFile(
        path.join(genDir, "FooQuery.graphql.swift"),
        "// gen\n",
      );
      await fs.writeFile(path.join(genDir, "Bar.pb.go"), "// gen\n");
      await fs.writeFile(path.join(srcDir, "handler.ts"), "export {};\n");
      const deadline = Date.now() + 5000;
      while (
        Date.now() < deadline &&
        !seen.some((p) => p.endsWith("handler.ts"))
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // A little extra so a late codegen event would have surfaced.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      await sub.unsubscribe();
      await fs.rm(realRoot, { recursive: true, force: true });
    }

    expect(seen.some((p) => p.endsWith("handler.ts"))).toBe(true);
    expect(seen.filter((p) => p.endsWith(".graphql.swift"))).toEqual([]);
    expect(seen.filter((p) => p.endsWith(".pb.go"))).toEqual([]);
  });
});
