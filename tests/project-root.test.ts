import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/project-registry", () => ({
  listProjects: vi.fn(() => []),
}));

import { listProjects } from "../src/lib/utils/project-registry";
import { findGitRoot, findProjectRoot } from "../src/lib/utils/project-root";

// Umbrella project layout: registered root with no .git of its own,
// containing nested git repos (the cokemusic/furni shape).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-root-"));
const umbrella = path.join(tmp, "umbrella");
const subrepo = path.join(umbrella, "subrepo");
const standalone = path.join(tmp, "standalone");
const plain = path.join(tmp, "plain");
for (const dir of [
  path.join(subrepo, ".git"),
  path.join(subrepo, "src"),
  path.join(standalone, ".git"),
  path.join(umbrella, "assets"),
  plain,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function register(...roots: string[]) {
  vi.mocked(listProjects).mockReturnValue(
    roots.map((root) => ({ root, name: path.basename(root) })) as ReturnType<
      typeof listProjects
    >,
  );
}

beforeEach(() => {
  register();
});

describe("findGitRoot", () => {
  it("walks up to the nearest .git", () => {
    expect(findGitRoot(path.join(subrepo, "src"))).toBe(subrepo);
  });

  it("returns null when no ancestor has .git", () => {
    expect(findGitRoot(plain)).toBeNull();
  });
});

describe("findProjectRoot", () => {
  it("returns the git root when it is registered", () => {
    register(standalone);
    expect(findProjectRoot(path.join(standalone))).toBe(standalone);
  });

  it("falls back to a registered umbrella when the git root is an unregistered subrepo", () => {
    register(umbrella);
    expect(findProjectRoot(path.join(subrepo, "src"))).toBe(umbrella);
  });

  it("prefers an exactly-registered subrepo over a registered ancestor", () => {
    register(umbrella, subrepo);
    expect(findProjectRoot(path.join(subrepo, "src"))).toBe(subrepo);
  });

  it("picks the deepest registered ancestor when several contain the start dir", () => {
    register(tmp, umbrella);
    expect(findProjectRoot(path.join(umbrella, "assets"))).toBe(umbrella);
  });

  it("resolves a registered umbrella from a git-less subdirectory", () => {
    register(umbrella);
    expect(findProjectRoot(path.join(umbrella, "assets"))).toBe(umbrella);
  });

  it("keeps the unregistered git root when nothing in the registry covers it", () => {
    expect(findProjectRoot(path.join(standalone))).toBe(standalone);
  });

  it("falls back to the start dir when there is no .git and no registry match", () => {
    expect(findProjectRoot(plain)).toBe(plain);
  });

  it("ignores a registry read failure and uses the .git walk", () => {
    vi.mocked(listProjects).mockImplementation(() => {
      throw new Error("corrupt registry");
    });
    expect(findProjectRoot(path.join(subrepo, "src"))).toBe(subrepo);
  });
});
