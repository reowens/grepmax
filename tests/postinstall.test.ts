import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.join(process.cwd(), "scripts", "postinstall.js");
const lancedbEntry = path.join(
  process.cwd(),
  "node_modules",
  "@lancedb",
  "lancedb",
  "dist",
  "index.js",
);

describe("postinstall", () => {
  it("does not run PATH-resolved gmax installers", () => {
    const source = fs.readFileSync(scriptPath, "utf-8");

    expect(source).not.toContain("execSync");
    expect(source).not.toMatch(/gmax install-/);
  });

  it("can run quietly as a no-op", () => {
    // Until 0.26.26 this script overlaid a vendored LanceDB build onto the
    // real node_modules (an rm -rf + copy of dist/). That overlay is gone
    // with the 0.38.0 GA pin; keep proving the module is left alone so a
    // future postinstall cannot quietly race the suite's lancedb imports.
    const before = fs.statSync(lancedbEntry).mtimeMs;

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf-8",
      env: { ...process.env, GMAX_POSTINSTALL_QUIET: "1" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(fs.statSync(lancedbEntry).mtimeMs).toBe(before);
  });
});
