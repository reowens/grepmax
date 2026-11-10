import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as watcher from "@parcel/watcher";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectFilePolicy,
  ROOT_IGNORE_PATTERNS,
} from "../src/lib/index/file-policy";
import { walk, walkDirectories } from "../src/lib/index/walker";
import { readNativeWatcherIgnores } from "../src/lib/index/watcher-ignore";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

// Every folder name the default policy names, at the root and nested.
function defaultDirectoryNames(): string[] {
  const names = new Set<string>();
  for (const pattern of ROOT_IGNORE_PATTERNS) {
    const name = /^(?:\*\*\/)?([A-Za-z0-9_.-]+)(?:\/\*\*)?$/.exec(pattern)?.[1];
    if (name) names.add(name);
  }
  return [...names];
}

async function fixture(): Promise<string> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "gmax-exclusion-parity-")),
  );
  roots.push(root);
  const dirs = [
    "src",
    "packages/app/src",
    "packages/app/scratch/deep",
    "packages/app/gen",
    "packages/app/nested/gen",
    "cache/run",
    "packages/app/cache",
    ".dev/logs",
  ];
  for (const name of defaultDirectoryNames()) {
    dirs.push(`${name}/sub`, `packages/app/${name}/sub`);
  }
  for (const dir of dirs)
    await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "cache/\n/.dev/\n");
  await fs.writeFile(path.join(root, "packages/app/.gitignore"), "scratch/\n");
  await fs.writeFile(path.join(root, "packages/app/.gmaxignore"), "/gen/\n");
  await fs.writeFile(path.join(root, "src/main.ts"), "export const a = 1;\n");
  await fs.writeFile(
    path.join(root, "packages/app/src/app.ts"),
    "export const b = 1;\n",
  );
  await fs.writeFile(
    path.join(root, "packages/app/nested/gen/kept.ts"),
    "export const c = 1;\n",
  );
  return root;
}

// The ignore set after Parcel's own normalization, without subscribing.
async function linuxMatcher(root: string) {
  let actual: { ignorePaths?: string[]; ignoreGlobs?: string[] } = {};
  const { createWrapper } = require("@parcel/watcher/wrapper");
  const wrapper = createWrapper({
    subscribe: async (_root: string, _fn: unknown, opts: typeof actual) => {
      actual = opts;
    },
  });
  await wrapper.subscribe(root, () => {}, {
    ignore: await readNativeWatcherIgnores(root, "linux"),
  });
  const globs = (actual.ignoreGlobs ?? []).map((p) => new RegExp(p));
  return {
    literals: actual.ignorePaths ?? [],
    matches: (relative: string) => globs.some((re) => re.test(relative)),
  };
}

describe("subscription and indexer exclusions", () => {
  it("excludes every folder the indexer excludes on Linux", async () => {
    const root = await fixture();
    // Globs alone, so a folder created after the subscribe is covered too.
    const { matches } = await linuxMatcher(root);
    const excluded: string[] = [];
    for await (const dir of walkDirectories(
      root,
      new ProjectFilePolicy(root),
    )) {
      if (dir.result.status !== "excluded") continue;
      excluded.push(path.relative(root, dir.path).split(path.sep).join("/"));
    }
    expect(excluded).toEqual(
      expect.arrayContaining([
        "node_modules",
        "packages/app/.turbo",
        "packages/app/.claude",
        "packages/app/fixtures/sub",
        "cache",
        "packages/app/cache",
        ".dev",
        "packages/app/scratch",
        "packages/app/gen",
      ]),
    );
    expect(excluded.filter((relative) => !matches(relative))).toEqual([]);
  });

  it("never excludes a folder or file the indexer keeps", async () => {
    const root = await fixture();
    const { literals, matches } = await linuxMatcher(root);
    const files: string[] = [];
    for await (const file of walk(root)) files.push(file);
    expect(files).toEqual(
      expect.arrayContaining([
        "src/main.ts",
        "packages/app/src/app.ts",
        "packages/app/nested/gen/kept.ts",
      ]),
    );
    const hidden = (relative: string) =>
      matches(relative) ||
      literals.some((p) => path.join(root, relative).startsWith(p + path.sep));
    expect(files.filter(hidden)).toEqual([]);
    for (const kept of ["src", "packages/app", "packages/app/nested/gen"])
      expect(matches(kept)).toBe(false);
    expect(matches(".gitignore")).toBe(false);
    expect(matches("packages/app/.gitignore")).toBe(false);
    expect(matches("packages/app/.gmaxignore")).toBe(false);
  });

  it("drops events in nested excluded folders in a real Linux subscription", async () => {
    const root = await fixture();
    const seen = new Set<string>();
    const errors: Error[] = [];
    const sub = await watcher.subscribe(
      root,
      (error, events) => {
        if (error) errors.push(error);
        for (const event of events) seen.add(event.path);
      },
      { ignore: await readNativeWatcherIgnores(root, "linux") },
    );
    const source = path.join(root, "packages/app/src/live.ts");
    const hidden = [
      "packages/app/scratch/deep/a.ts",
      "packages/app/gen/b.ts",
      "cache/run/c.ts",
      "packages/app/node_modules/sub/d.ts",
    ].map((relative) => path.join(root, relative));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const file of hidden) await fs.writeFile(file, "x\n");
      await fs.writeFile(source, "export const live = 1;\n");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !seen.has(source))
        await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(errors).toEqual([]);
      expect(seen.has(source)).toBe(true);
      expect(hidden.filter((file) => seen.has(file))).toEqual([]);
    } finally {
      await sub.unsubscribe();
    }
  });
});
