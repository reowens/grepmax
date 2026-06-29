import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.join(process.cwd(), "scripts", "postinstall.js");

describe("postinstall", () => {
  it("does not run PATH-resolved gmax installers", () => {
    const source = fs.readFileSync(scriptPath, "utf-8");

    expect(source).not.toContain("execSync");
    expect(source).not.toMatch(/gmax install-/);
  });

  it("can run quietly as a no-op", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf-8",
      env: { ...process.env, GMAX_POSTINSTALL_QUIET: "1" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
