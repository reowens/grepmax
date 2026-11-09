import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findLegacyProjectIndex } from "../src/lib/utils/legacy-index";

describe("findLegacyProjectIndex", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-legacy-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("is silent when the working directory holds the central store", () => {
    fs.mkdirSync(path.join(tmp, ".gmax", "lancedb"), { recursive: true });
    expect(findLegacyProjectIndex(tmp, path.join(tmp, ".gmax"))).toBeNull();
  });

  it("is silent when the central store is reached through a symlink", () => {
    const store = path.join(tmp, "store");
    fs.mkdirSync(path.join(store, "lancedb"), { recursive: true });
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    fs.symlinkSync(store, path.join(home, ".gmax"));
    expect(findLegacyProjectIndex(home, store)).toBeNull();
  });

  it("reports a project's own .gmax/lancedb", () => {
    const project = path.join(tmp, "project");
    fs.mkdirSync(path.join(project, ".gmax", "lancedb"), { recursive: true });
    expect(
      findLegacyProjectIndex(project, path.join(tmp, "home", ".gmax")),
    ).toBe(path.join(project, ".gmax"));
  });

  it("is silent without a lancedb directory", () => {
    fs.mkdirSync(path.join(tmp, ".gmax"));
    expect(findLegacyProjectIndex(tmp, path.join(tmp, "other"))).toBeNull();
  });
});
