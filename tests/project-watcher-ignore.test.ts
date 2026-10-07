import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as watcher from "@parcel/watcher";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectFilePolicy } from "../src/lib/index/file-policy";
import {
  nativeProjectIgnoreGlobs,
  readProjectWatcherIgnores,
} from "../src/lib/index/watcher-ignore";

const rule =
  "/docs/plans/assets/ios-visual-language/**/*.json\n/docs/plans/assets/ios-visual-language/**/*.png\n";
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

  it("reloads policy edits and deletion and bounds oversized policies", async () => {
    const root = await fixture();
    const file = path.join(root, ".gmaxignore");
    expect(await readProjectWatcherIgnores(root)).toEqual([]);
    await fs.writeFile(file, rule);
    expect(await readProjectWatcherIgnores(root)).toContain(
      "docs/plans/assets/ios-visual-language/**/*.json",
    );
    await fs.writeFile(
      file,
      `${rule}!docs/plans/assets/ios-visual-language/keep.json\n`,
    );
    expect(await readProjectWatcherIgnores(root)).toEqual([]);
    await fs.writeFile(file, "#".repeat(65537));
    expect(await readProjectWatcherIgnores(root)).toEqual([]);
    await fs.unlink(file);
    expect(await readProjectWatcherIgnores(root)).toEqual([]);
  });

  it("filters generated JSON in a real subscription while delivering notes, source JSON and policy edits", async () => {
    const root = await fixture();
    const generated = path.join(
      root,
      "docs/plans/assets/ios-visual-language/run/measure",
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
      { ignore: await readProjectWatcherIgnores(root) },
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
