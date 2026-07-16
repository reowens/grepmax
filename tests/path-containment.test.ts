import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPathWithin,
  PathContainmentError,
  resolveContainedExistingPath,
  resolveContainedFile,
  resolveContainedPath,
} from "../src/lib/utils/path-containment";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-containment-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("path containment", () => {
  it("accepts relative and absolute paths inside the root", () => {
    expect(resolveContainedPath("/p/app", "packages/api")).toBe(
      "/p/app/packages/api",
    );
    expect(resolveContainedPath("/p/app", "/p/app/packages/api")).toBe(
      "/p/app/packages/api",
    );
    expect(isPathWithin("/p/app", "/p/app/packages/api")).toBe(true);
  });

  it("accepts or rejects root equality according to allowRoot", () => {
    expect(resolveContainedPath("/p/app", ".")).toBe("/p/app");
    expect(() =>
      resolveContainedPath("/p/app", ".", { allowRoot: false }),
    ).toThrow(PathContainmentError);
  });

  it("rejects traversal, outside absolute paths, and sibling prefixes", () => {
    for (const candidate of [
      "../other",
      "/p/other",
      "/p/application/file.ts",
    ]) {
      expect(() => resolveContainedPath("/p/app", candidate)).toThrow(
        PathContainmentError,
      );
    }
  });

  it("rejects NUL bytes", () => {
    expect(() => resolveContainedPath("/p/app", "src/\0secret.ts")).toThrow(
      PathContainmentError,
    );
  });

  it("rejects existing symlink escapes", () => {
    const root = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "secret.ts"), "secret");
    fs.symlinkSync(outside, path.join(root, "linked"));

    expect(() =>
      resolveContainedPath(root, "linked/secret.ts", {
        verifyExistingTarget: true,
      }),
    ).toThrow(PathContainmentError);
  });

  it("rejects nonexistent paths beneath a symlink escape", () => {
    const root = tempDir();
    const outside = tempDir();
    fs.symlinkSync(outside, path.join(root, "linked"));

    expect(() =>
      resolveContainedPath(root, "linked/not-created.ts", {
        verifyExistingTarget: true,
      }),
    ).toThrow(PathContainmentError);
  });

  it("rejects poisoned sibling-prefix file paths", () => {
    const parent = tempDir();
    const root = path.join(parent, "api");
    const sibling = path.join(parent, "api-old");
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    const poisoned = path.join(sibling, "secret.ts");
    fs.writeFileSync(poisoned, "secret");

    expect(() => resolveContainedFile(root, poisoned)).toThrow(
      PathContainmentError,
    );
  });

  it("rejects a file replaced by an escaping symlink after indexing", () => {
    const root = tempDir();
    const outside = tempDir();
    const indexedPath = path.join(root, "source.ts");
    const secretPath = path.join(outside, "secret.ts");
    fs.writeFileSync(indexedPath, "safe");
    fs.writeFileSync(secretPath, "secret");
    fs.unlinkSync(indexedPath);
    fs.symlinkSync(secretPath, indexedPath);

    expect(() => resolveContainedFile(root, indexedPath)).toThrow(
      PathContainmentError,
    );
  });
});

describe("resolveContainedExistingPath", () => {
  function projectWithSubdir(): { root: string; sub: string } {
    const root = tempDir();
    const sub = path.join(root, "subrepo");
    fs.mkdirSync(path.join(sub, "src"), { recursive: true });
    fs.writeFileSync(path.join(sub, "src", "a.ts"), "a");
    fs.writeFileSync(path.join(root, "top.ts"), "top");
    return { root, sub };
  }

  it("prefers an existing cwd-relative match", () => {
    const { root, sub } = projectWithSubdir();
    expect(resolveContainedExistingPath(root, "src/a.ts", { cwd: sub })).toBe(
      path.join(sub, "src", "a.ts"),
    );
  });

  it("falls back to a root-relative match", () => {
    const { root, sub } = projectWithSubdir();
    expect(resolveContainedExistingPath(root, "top.ts", { cwd: sub })).toBe(
      path.join(root, "top.ts"),
    );
  });

  it("returns null when the target exists under neither base", () => {
    const { root, sub } = projectWithSubdir();
    expect(
      resolveContainedExistingPath(root, "missing.ts", { cwd: sub }),
    ).toBeNull();
  });

  it("skips a cwd-relative match outside the root", () => {
    const { root } = projectWithSubdir();
    const outsideCwd = tempDir();
    fs.writeFileSync(path.join(outsideCwd, "top.ts"), "outside");
    expect(
      resolveContainedExistingPath(root, "top.ts", { cwd: outsideCwd }),
    ).toBe(path.join(root, "top.ts"));
  });

  it("returns null for an outside-only match by default", () => {
    const { root } = projectWithSubdir();
    const outsideCwd = tempDir();
    fs.writeFileSync(path.join(outsideCwd, "only-here.ts"), "outside");
    expect(
      resolveContainedExistingPath(root, "only-here.ts", { cwd: outsideCwd }),
    ).toBeNull();
  });

  it("throws for an outside-only match with onOutside: 'throw'", () => {
    const { root } = projectWithSubdir();
    const outsideCwd = tempDir();
    fs.writeFileSync(path.join(outsideCwd, "only-here.ts"), "outside");
    expect(() =>
      resolveContainedExistingPath(root, "only-here.ts", {
        cwd: outsideCwd,
        onOutside: "throw",
      }),
    ).toThrow(PathContainmentError);
  });
});
