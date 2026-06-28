import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Per-test fake $HOME so install/uninstall touch a temp ~/.factory only.
const h = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: { ...actual, homedir: () => h.home },
    homedir: () => h.home,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(() => "/usr/local/bin/gmax\n"),
  };
});

import { installDroid, uninstallDroid } from "../src/commands/droid";

function factoryDir(): string {
  return path.join(h.home, ".factory");
}
function settingsPath(): string {
  return path.join(factoryDir(), "settings.json");
}
function gmaxStartCmd(): string {
  return `node "${path.join(factoryDir(), "hooks", "gmax", "gmax_start.js")}"`;
}

describe("droid install settings safety", () => {
  beforeEach(() => {
    h.home = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-droid-"));
    fs.mkdirSync(factoryDir(), { recursive: true });
    (installDroid as Command).exitOverride();
    (uninstallDroid as Command).exitOverride();
  });

  afterEach(() => {
    fs.rmSync(h.home, { recursive: true, force: true });
  });

  it("aborts install on invalid settings JSON instead of clobbering it with {}", async () => {
    const garbage = '{ "hooks": [ this is not json }';
    fs.writeFileSync(settingsPath(), garbage);

    await expect(
      (installDroid as Command).parseAsync([], { from: "user" }),
    ).rejects.toThrow(/invalid JSON/i);

    // The user's file is untouched, and no hook scripts were written.
    expect(fs.readFileSync(settingsPath(), "utf-8")).toBe(garbage);
    expect(fs.existsSync(path.join(factoryDir(), "hooks", "gmax"))).toBe(false);
  });

  it("preserves existing non-gmax hooks on install", async () => {
    const userHook = {
      hooks: {
        SessionStart: [{ hooks: [{ command: "node /other/thing.js" }] }],
      },
      myCustomSetting: 42,
    };
    fs.writeFileSync(settingsPath(), JSON.stringify(userHook, null, 2));

    await (installDroid as Command).parseAsync([], { from: "user" });

    const after = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    // user's hook + setting survive...
    const cmds = after.hooks.SessionStart.map(
      (e: { hooks: { command: string }[] }) => e.hooks[0].command,
    );
    expect(cmds).toContain("node /other/thing.js");
    expect(after.myCustomSetting).toBe(42);
    // ...and gmax's hook is added.
    expect(cmds.some((c: string) => c.includes("gmax_start.js"))).toBe(true);
    expect(after.enableHooks).toBe(true);
  });
});

describe("droid uninstall removes only gmax hooks", () => {
  beforeEach(() => {
    h.home = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-droid-"));
    fs.mkdirSync(path.join(factoryDir(), "hooks", "gmax"), { recursive: true });
    fs.mkdirSync(path.join(factoryDir(), "skills", "gmax"), {
      recursive: true,
    });
    (uninstallDroid as Command).exitOverride();
  });

  afterEach(() => {
    fs.rmSync(h.home, { recursive: true, force: true });
  });

  it("strips gmax hook entries while preserving unrelated user hooks", async () => {
    const settings = {
      enableHooks: true,
      hooks: {
        SessionStart: [
          { matcher: "startup|resume", hooks: [{ command: gmaxStartCmd() }] },
          { hooks: [{ command: "node /home/me/.factory/hooks/custom.js" }] },
        ],
        PreToolUse: [{ hooks: [{ command: "echo unrelated" }] }],
      },
    };
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));

    await (uninstallDroid as Command).parseAsync([], { from: "user" });

    const after = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    const starts = after.hooks.SessionStart.map(
      (e: { hooks: { command: string }[] }) => e.hooks[0].command,
    );
    // gmax entry gone, user's custom SessionStart hook + PreToolUse survive.
    expect(starts.some((c: string) => c.includes("gmax_start.js"))).toBe(false);
    expect(starts).toContain("node /home/me/.factory/hooks/custom.js");
    expect(after.hooks.PreToolUse[0].hooks[0].command).toBe("echo unrelated");
    // gmax hook scripts/skills are removed from disk.
    expect(fs.existsSync(path.join(factoryDir(), "hooks", "gmax"))).toBe(false);
    expect(fs.existsSync(path.join(factoryDir(), "skills", "gmax"))).toBe(
      false,
    );
  });
});
