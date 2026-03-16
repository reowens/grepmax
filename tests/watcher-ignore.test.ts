import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ignore from "ignore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WATCHER_IGNORE_PATTERNS } from "../src/lib/index/watcher";

describe("serve watcher ignore predicate", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gmax-watch-"));
    await fs.mkdir(path.join(tempRoot, ".gmax"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, ".gmax", "server.json"), "{}");
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("WATCHER_IGNORE_PATTERNS contains expected directory patterns", () => {
    expect(WATCHER_IGNORE_PATTERNS.length).toBeGreaterThan(0);
    const strings = WATCHER_IGNORE_PATTERNS.filter(
      (p): p is string => typeof p === "string",
    );
    expect(strings).toContain("**/node_modules/**");
    expect(strings).toContain("**/.git/**");
    expect(strings).toContain("**/.gmax/**");
  });

  it("does not throw on the root path and ignores gmax/git internals", async () => {
    const globPatterns = WATCHER_IGNORE_PATTERNS.filter(
      (p): p is string => typeof p === "string",
    );
    const regexPatterns = WATCHER_IGNORE_PATTERNS.filter(
      (p): p is RegExp => p instanceof RegExp,
    );
    const filter = ignore().add(globPatterns);

    const ignored = (watchedPath: string | Buffer) => {
      const pathStr = watchedPath.toString();
      const rel = path.relative(tempRoot, pathStr).replace(/\\/g, "/");
      if (!rel) return false;
      if (filter.ignores(rel)) return true;
      return regexPatterns.some((rx) => rx.test(pathStr));
    };

    expect(() => ignored(tempRoot)).not.toThrow();
    expect(ignored(tempRoot)).toBe(false);

    expect(ignored(path.join(tempRoot, ".gmax", "server.json"))).toBe(true);
    expect(ignored(path.join(tempRoot, ".git", "HEAD"))).toBe(true);
  });
});
