import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/postrelease.sh");

function run(args: string[] = [], failure = "") {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gmax-release-hook-"),
  );
  const log = path.join(directory, "commands");
  try {
    for (const command of ["git", "npm", "gh", "gmax"]) {
      fs.writeFileSync(
        path.join(directory, command),
        `#!/bin/sh
printf '%s\n' '${command}' >> "$RELEASE_TEST_LOG"
[ "$RELEASE_TEST_FAIL" != '${command}' ]
`,
        { mode: 0o755 },
      );
    }
    const result = spawnSync("/bin/bash", [script, ...args], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        npm_package_version: "0.26.85",
        GMAX_NO_AUTOSTART: "1",
        RELEASE_TEST_LOG: log,
        RELEASE_TEST_FAIL: failure,
      },
      timeout: 5000,
      encoding: "utf8",
    });
    return {
      result,
      commands: fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n")
        : [],
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("release hook does not wait on publication", () => {
  it("pushes and returns without querying CI or installing", () => {
    const { result, commands } = run();
    expect(result.status).toBe(0);
    expect(commands).toEqual(["git", "git"]);
    expect(result.stdout).toContain(
      "publication is an explicit local operation",
    );
  });

  it("surfaces a push failure immediately", () => {
    const { result, commands } = run([], "git");
    expect(result.status).not.toBe(0);
    expect(commands).toEqual(["git"]);
  });

  it("attempts an explicit installation once and preserves quarantine", () => {
    const { result, commands } = run(["--install"]);
    expect(result.status).toBe(0);
    expect(commands).toEqual(["npm"]);
    expect(result.stdout).toContain(
      "preserving it and skipping daemon restart",
    );
  });

  it("surfaces an unavailable package without retries or handover", () => {
    const { result, commands } = run(["--install"], "npm");
    expect(result.status).not.toBe(0);
    expect(commands).toEqual(["npm"]);
  });

  it("rejects unknown arguments without side effects", () => {
    const { result, commands } = run(["--unknown"]);
    expect(result.status).toBe(2);
    expect(commands).toEqual([]);
  });
});
