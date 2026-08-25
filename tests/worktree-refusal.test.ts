import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isGitWorktreeRoot } from "../src/lib/utils/blocked-roots";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-worktree-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("isGitWorktreeRoot", () => {
  it("detects a linked worktree by its .git pointer file", () => {
    fs.writeFileSync(
      path.join(tmp, ".git"),
      "gitdir: /Users/x/repo/.git/worktrees/feature-a\n",
    );
    expect(isGitWorktreeRoot(tmp)).toBe(true);
  });

  it("leaves a normal repository alone", () => {
    fs.mkdirSync(path.join(tmp, ".git"));
    expect(isGitWorktreeRoot(tmp)).toBe(false);
  });

  it("leaves a submodule alone — its gitdir is under .git/modules", () => {
    fs.writeFileSync(
      path.join(tmp, ".git"),
      "gitdir: ../.git/modules/vendor/thing\n",
    );
    expect(isGitWorktreeRoot(tmp)).toBe(false);
  });

  it("treats a directory with no .git as not a worktree", () => {
    expect(isGitWorktreeRoot(tmp)).toBe(false);
  });
});
