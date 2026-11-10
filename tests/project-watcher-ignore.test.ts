import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as watcher from "@parcel/watcher";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectFilePolicy } from "../src/lib/index/file-policy";
import {
  nativeProjectIgnoreGlobs,
  readNativeWatcherIgnores,
} from "../src/lib/index/watcher-ignore";

const rule =
  "/docs/plans/assets/ui-snapshots/**/*.json\n/docs/plans/assets/ui-snapshots/**/*.png\n";
const roots: string[] = [];
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "gmax-project-ignore-")),
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

describe("project native watcher exclusions", () => {
  it("keeps anchored rules anchored and directory-only rules from hiding files", () => {
    expect(nativeProjectIgnoreGlobs("/root.json\ncache/\nfoo**bar\n")).toEqual([
      "root.json",
      "root.json/**",
      "**/cache/**",
    ]);
    expect(nativeProjectIgnoreGlobs("*.json\n")).toEqual([
      "**/*.json",
      "**/*.json/**",
    ]);
  });

  it("leaves re-inclusions, escaped patterns and policy-file exclusions to file policy", () => {
    expect(nativeProjectIgnoreGlobs("*.json\n!source.json\n")).toEqual([]);
    expect(
      nativeProjectIgnoreGlobs("\\!literal\n[ab].json\n.*\n**/*\n"),
    ).toEqual([]);
  });

  it("scopes nested rules to their folder", () => {
    expect(nativeProjectIgnoreGlobs("tmp/\n/out\n*.log\n", "pkg/a")).toEqual([
      "pkg/a/**/tmp/**",
      "pkg/a/out",
      "pkg/a/out/**",
      "pkg/a/**/*.log",
      "pkg/a/**/*.log/**",
    ]);
  });

  it("reloads policy edits and deletion", async () => {
    const root = await fixture();
    const file = path.join(root, ".gmaxignore");
    const scoped = "docs/plans/assets/ui-snapshots/**/*.json";
    expect(await readNativeWatcherIgnores(root)).not.toContain(scoped);
    await fs.writeFile(file, rule);
    expect(await readNativeWatcherIgnores(root)).toContain(scoped);
    await fs.writeFile(
      file,
      `${rule}!docs/plans/assets/ui-snapshots/keep.json\n`,
    );
    expect(await readNativeWatcherIgnores(root)).not.toContain(scoped);
    await fs.writeFile(file, rule);
    await fs.unlink(file);
    expect(await readNativeWatcherIgnores(root)).not.toContain(scoped);
  });

  it("reads nested .gitignore and .gmaxignore rules with their scope prefix", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "packages/app/src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "packages/app/.gitignore"),
      "scratch/\n",
    );
    await fs.writeFile(path.join(root, "packages/app/.gmaxignore"), "/out\n");
    const ignores = (await readNativeWatcherIgnores(root)).map(String);
    expect(ignores).toContain("packages/app/**/scratch/**");
    expect(ignores).toContain("packages/app/out/**");
    expect(ignores).not.toContain("**/scratch/**");
  });

  it("skips a folder's rules when either of its policy files negates", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "packages/app"), { recursive: true });
    await fs.writeFile(path.join(root, ".gitignore"), "cache/\n");
    // Both files feed one filter, so the re-inclusion can undo the exclusion.
    await fs.writeFile(
      path.join(root, "packages/app/.gitignore"),
      "scratch/\n",
    );
    await fs.writeFile(
      path.join(root, "packages/app/.gmaxignore"),
      "!scratch/\n",
    );
    const ignores = (await readNativeWatcherIgnores(root)).map(String);
    expect(ignores.some((p) => p.startsWith("packages/app/"))).toBe(false);
    expect(ignores).toContain("**/cache/**");
    const policy = new ProjectFilePolicy(root);
    await fs.mkdir(path.join(root, "packages/app/scratch"));
    expect(
      (await policy.classifyDirectory(path.join(root, "packages/app/scratch")))
        .status,
    ).toBe("traverse");
  });

  it("never reads rules inside an excluded folder or a folder Parcel would read as a pattern", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "tmp"), { recursive: true });
    await fs.mkdir(path.join(root, "app/(group)"), { recursive: true });
    await fs.writeFile(path.join(root, ".gitignore"), "tmp/\n");
    await fs.writeFile(path.join(root, "tmp/.gitignore"), "inner/\n");
    await fs.writeFile(path.join(root, "app/(group)/.gitignore"), "cache/\n");
    const ignores = (await readNativeWatcherIgnores(root)).map(String);
    expect(ignores.some((p) => p.startsWith("tmp/"))).toBe(false);
    expect(ignores.some((p) => p.includes("(group)"))).toBe(false);
    expect(ignores).toContain("**/tmp/**");
  });

  it("filters generated JSON in a real subscription while delivering notes, source JSON and policy edits", async () => {
    const root = await fixture();
    const generated = path.join(
      root,
      "docs/plans/assets/ui-snapshots/run/measure",
    );
    await fs.mkdir(generated, { recursive: true });
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, ".gmaxignore"), rule);
    const seen = new Set<string>();
    const errors: Error[] = [];
    const sub = await watcher.subscribe(
      root,
      (error, events) => {
        if (error) errors.push(error);
        for (const event of events) seen.add(event.path);
      },
      { ignore: await readNativeWatcherIgnores(root) },
    );
    const artifact = path.join(generated, "measurement.json");
    const screenshot = path.join(generated, "screenshot.png");
    const note = path.join(generated, "notes.md");
    const source = path.join(root, "src/config.json");
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.writeFile(artifact, '{"generated":true}\n');
      await fs.writeFile(screenshot, "generated screenshot fixture\n");
      await fs.writeFile(note, "# Authored notes\n");
      await fs.writeFile(source, '{"source":true}\n');
      await fs.appendFile(path.join(root, ".gmaxignore"), "# edited\n");
      const deadline = Date.now() + 5000;
      while (
        Date.now() < deadline &&
        (!seen.has(note) ||
          !seen.has(source) ||
          !seen.has(path.join(root, ".gmaxignore")))
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(errors).toEqual([]);
      expect(seen.has(artifact)).toBe(false);
      expect(seen.has(screenshot)).toBe(false);
      expect(seen.has(note)).toBe(true);
      expect(seen.has(source)).toBe(true);
      expect(seen.has(path.join(root, ".gmaxignore"))).toBe(true);
      const policy = new ProjectFilePolicy(root);
      expect((await policy.classifyFile(artifact)).status).toBe("excluded");
      expect((await policy.classifyFile(note)).status).toBe("indexable");
      expect((await policy.classifyFile(source)).status).toBe("indexable");
    } finally {
      await sub.unsubscribe();
    }
  });
});
