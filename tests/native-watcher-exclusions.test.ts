import { type Dir, promises as filesystem } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as watcher from "@parcel/watcher";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WATCHER_IGNORE_GLOBS } from "../src/lib/index/watcher";
import { readNativeWatcherIgnores } from "../src/lib/index/watcher-ignore";

const roots: string[] = [];
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "gmax-native-exclusions-")),
  );
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
// Exercise Parcel's actual normalization boundary, without starting another
// native subscription or loading a store/model.
async function normalized(root: string) {
  let actual: any;
  const { createWrapper } = require("@parcel/watcher/wrapper");
  const wrapper = createWrapper({
    subscribe: async (_root: string, _fn: unknown, opts: unknown) => {
      actual = opts;
    },
  });
  await wrapper.subscribe(root, () => {}, {
    ignore: await readNativeWatcherIgnores(root, WATCHER_IGNORE_GLOBS),
  });
  return actual;
}
describe("macOS stream exclusions", () => {
  it("promotes actual policy-excluded directories into literal stream paths", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, ".dev/logs"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.mkdir(path.join(root, "packages/ios/.build"), { recursive: true });
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, ".gitignore"), ".dev/\n");
    const opts = await normalized(root);
    expect(opts.ignorePaths).toEqual(
      expect.arrayContaining([
        path.join(root, ".dev"),
        path.join(root, "node_modules"),
        path.join(root, "packages/ios/.build"),
      ]),
    );
    expect(opts.ignorePaths).not.toContain(path.join(root, "src"));
    expect(opts.ignoreGlobs.length).toBeGreaterThan(0);
  });
  it("does not let nested dependencies crowd out the noisy excluded root", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, ".dev"));
    await fs.writeFile(path.join(root, ".gitignore"), ".dev/\n");
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fs.mkdir(path.join(root, `packages/p${i}/node_modules`), {
          recursive: true,
        }),
      ),
    );
    const opts = await normalized(root);
    expect(opts.ignorePaths).toHaveLength(8);
    expect(opts.ignorePaths).toContain(path.join(root, ".dev"));
  });
  it("finds nested build roots before a broad source tree spends the entry budget", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "src"));
    await fs.mkdir(path.join(root, "packages/ios/Core/.build"), {
      recursive: true,
    });
    const open = filesystem.opendir.bind(filesystem);
    const intercepted = vi
      .spyOn(filesystem, "opendir")
      .mockImplementation(async (...args) => {
        if (String(args[0]) !== path.join(root, "src")) return open(...args);
        return {
          async *[Symbol.asyncIterator]() {
            for (let i = 0; i < 20000; i++)
              yield { name: `file${i}.ts`, isDirectory: () => false };
          },
        } as unknown as Dir;
      });
    try {
      const opts = await normalized(root);
      expect(opts.ignorePaths).toContain(
        path.join(root, "packages/ios/Core/.build"),
      );
    } finally {
      intercepted.mockRestore();
    }
  });
  it("does not exclude a re-included directory and refreshes after policy edits/deletion", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, ".dev"));
    const file = path.join(root, ".gitignore");
    await fs.writeFile(file, ".dev/\n!.dev/\n");
    expect((await normalized(root)).ignorePaths ?? []).not.toContain(
      path.join(root, ".dev"),
    );
    await fs.writeFile(file, ".dev/\n");
    expect((await normalized(root)).ignorePaths).toContain(
      path.join(root, ".dev"),
    );
    await fs.unlink(file);
    expect((await normalized(root)).ignorePaths ?? []).not.toContain(
      path.join(root, ".dev"),
    );
  });
  it("honors nested policy while keeping authored siblings observable", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "packages/app/scratch"), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, "packages/app/src"));
    await fs.writeFile(
      path.join(root, "packages/app/.gitignore"),
      "scratch/\n",
    );
    const opts = await normalized(root);
    expect(opts.ignorePaths).toContain(path.join(root, "packages/app/scratch"));
    expect(opts.ignorePaths).not.toContain(path.join(root, "packages/app"));
    expect(opts.ignorePaths).not.toContain(path.join(root, "packages/app/src"));
  });
  it("caps all literal paths at eight and retains excess literals as regex filters", async () => {
    const root = await fixture();
    const directories = Array.from({ length: 12 }, (_, i) => `artifact${i}`);
    await Promise.all(directories.map((d) => fs.mkdir(path.join(root, d))));
    await fs.writeFile(
      path.join(root, ".gmaxignore"),
      `${directories.map((d) => `/${d}`).join("\n")}\n/root.json\n`,
    );
    const opts = await normalized(root);
    expect(opts.ignorePaths).toHaveLength(8);
    const matched = (rel: string) =>
      opts.ignoreGlobs.some((pattern: string) =>
        new RegExp(pattern).test(rel),
      ) ||
      opts.ignorePaths.some(
        (p: string) =>
          path.join(root, rel) === p ||
          path.join(root, rel).startsWith(p + path.sep),
      );
    for (const d of directories) {
      expect(matched(d)).toBe(true);
      expect(matched(`${d}/generated.json`)).toBe(true);
    }
    expect(matched("root.json")).toBe(true);
    expect(matched("src/root.json")).toBe(false);
  });
  it("keeps a child re-inclusion visible when its parent is traversable", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "artifacts"));
    await fs.writeFile(
      path.join(root, ".gmaxignore"),
      "/artifacts/*\n!/artifacts/source.ts\n",
    );
    expect((await normalized(root)).ignorePaths ?? []).not.toContain(
      path.join(root, "artifacts"),
    );
  });
  it("delivers source and control-file edits with real literal native exclusions", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, ".dev"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, ".gitignore"), ".dev/\n");
    const seen = new Set<string>();
    const errors: Error[] = [];
    const sub = await watcher.subscribe(
      root,
      (error, events) => {
        if (error) errors.push(error);
        for (const event of events) seen.add(event.path);
      },
      { ignore: await readNativeWatcherIgnores(root, WATCHER_IGNORE_GLOBS) },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.writeFile(path.join(root, ".dev/receipt.json"), "{}\n");
      await fs.writeFile(
        path.join(root, "src/main.ts"),
        "export const live = 1;\n",
      );
      await fs.appendFile(path.join(root, ".gitignore"), "# edited\n");
      const deadline = Date.now() + 5000;
      while (
        Date.now() < deadline &&
        !(
          seen.has(path.join(root, "src/main.ts")) &&
          seen.has(path.join(root, ".gitignore"))
        )
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seen.has(path.join(root, "src/main.ts"))).toBe(true);
      expect(seen.has(path.join(root, ".gitignore"))).toBe(true);
      expect(seen.has(path.join(root, ".dev/receipt.json"))).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await sub.unsubscribe();
    }
  });
  it("never promotes symlinks or unreadable policies", async () => {
    const root = await fixture();
    await fs.symlink(os.tmpdir(), path.join(root, "node_modules"));
    await fs.mkdir(path.join(root, ".dev"));
    await fs.mkdir(path.join(root, ".gitignore"));
    expect((await normalized(root)).ignorePaths ?? []).toEqual([]);
  });
});
