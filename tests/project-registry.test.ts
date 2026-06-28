import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Override PATHS.globalRoot to a temp dir so tests don't touch the real registry.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-registry-test-"));

vi.mock("../src/config", async () => {
  const actual =
    await vi.importActual<typeof import("../src/config")>("../src/config");
  return {
    ...actual,
    PATHS: { ...actual.PATHS, globalRoot: tmpRoot },
  };
});

const REGISTRY_FILE = path.join(tmpRoot, "projects.json");

beforeEach(() => {
  if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
});

afterEach(() => {
  if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
});

function writeRegistry(entries: Array<{ name: string; root: string }>) {
  const full = entries.map((e) => ({
    ...e,
    vectorDim: 384,
    modelTier: "small",
    embedMode: "auto",
    lastIndexed: "2026-01-01T00:00:00Z",
  }));
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(full, null, 2));
}

describe("resolveProjectRoot", () => {
  it("returns absolute path unchanged when arg contains a separator", async () => {
    const { resolveProjectRoot } = await import(
      "../src/lib/utils/project-registry"
    );
    expect(resolveProjectRoot("/abs/path/x")).toBe("/abs/path/x");
  });

  it("resolves a registered name to its root", async () => {
    const { resolveProjectRoot } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([{ name: "my-app", root: "/Users/me/projects/my-app" }]);
    expect(resolveProjectRoot("my-app")).toBe("/Users/me/projects/my-app");
  });

  it("throws with available list when no name matches", async () => {
    const { resolveProjectRoot } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([{ name: "app-a", root: "/x/app-a" }]);
    expect(() => resolveProjectRoot("nope")).toThrow(/No registered project/);
    expect(() => resolveProjectRoot("nope")).toThrow(/app-a/);
  });

  it("throws with both paths on duplicate name", async () => {
    const { resolveProjectRoot } = await import(
      "../src/lib/utils/project-registry"
    );
    writeRegistry([
      { name: "dup", root: "/a/dup" },
      { name: "dup", root: "/b/dup" },
    ]);
    expect(() => resolveProjectRoot("dup")).toThrow(/Multiple registered/);
    expect(() => resolveProjectRoot("dup")).toThrow(/\/a\/dup/);
    expect(() => resolveProjectRoot("dup")).toThrow(/\/b\/dup/);
  });

  it("treats existing directory args as paths even without a separator", async () => {
    const { resolveProjectRoot } = await import(
      "../src/lib/utils/project-registry"
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-existing-"));
    const basename = path.basename(dir);
    writeRegistry([{ name: basename, root: "/some/other/place" }]);
    // Run from the parent so basename resolves to the real dir.
    const cwd = process.cwd();
    process.chdir(path.dirname(dir));
    try {
      expect(resolveProjectRoot(basename)).toBe(path.resolve(basename));
    } finally {
      process.chdir(cwd);
      fs.rmdirSync(dir);
    }
  });
});
