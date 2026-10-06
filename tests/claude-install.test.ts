import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  marketplaces: [] as Record<string, unknown>[],
  installed: [] as Record<string, unknown>[],
  calls: [] as { args: string[]; cwd?: string }[],
  fail: "",
  invalid: false,
  missingProject: false,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (
    _command: string,
    args: string[],
    options: { cwd?: string },
    callback: (error: Error | null, result?: unknown) => void,
  ) => {
    h.calls.push({ args, cwd: options.cwd });
    if (h.fail && args.join(" ").includes(h.fail)) {
      callback(new Error("CLI refused"));
      return;
    }
    const listing = args.includes("list");
    callback(null, {
      stdout: listing
        ? h.invalid
          ? "not JSON"
          : JSON.stringify(
              args.includes("marketplace") ? h.marketplaces : h.installed,
            )
        : "updated\n",
      stderr: "",
    });
  },
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: (file: string) => !(h.missingProject && file === "/project"),
}));

import { installClaudeCode } from "../src/commands/claude-code";

async function install() {
  await (installClaudeCode as Command).parseAsync([], { from: "user" });
}
function mutations() {
  return h.calls.filter(({ args }) => !args.includes("list"));
}
describe("Claude installation preserves existing state", () => {
  beforeEach(() => {
    h.calls = [];
    h.marketplaces = [];
    h.installed = [];
    h.fail = "";
    h.invalid = false;
    h.missingProject = false;
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  it("adds a local source and user installation only for a new plugin", async () => {
    await install();
    expect(mutations().map(({ args }) => args.slice(0, 3))).toEqual([
      ["plugin", "marketplace", "add"],
      ["plugin", "install", "grepmax@grepmax"],
    ]);
    expect(mutations()[1].args.slice(3)).toEqual(["--scope", "user"]);
    expect(h.calls.some(({ args }) => args.includes("remove"))).toBe(false);
  });

  it("refreshes an existing GitHub source without retargeting or enabling", async () => {
    h.marketplaces = [
      { name: "grepmax", source: "github", repo: "reowens/grepmax" },
    ];
    h.installed = [{ id: "grepmax@grepmax", scope: "user", enabled: false }];
    await install();
    expect(mutations().map(({ args }) => args)).toEqual([
      ["plugin", "marketplace", "update", "grepmax"],
      ["plugin", "update", "grepmax@grepmax", "--scope", "user"],
    ]);
    expect(h.installed[0].enabled).toBe(false);
  });

  it("updates project and local scopes from their original directories", async () => {
    h.marketplaces = [
      { name: "grepmax", source: "directory", path: "/other/prefix" },
    ];
    h.installed = [
      { id: "grepmax@grepmax", scope: "user" },
      { id: "grepmax@grepmax", scope: "project", projectPath: "/project" },
      { id: "grepmax@grepmax", scope: "local", projectPath: "/other project" },
      { id: "unrelated@else", scope: "user" },
    ];
    await install();
    expect(
      mutations()
        .slice(1)
        .map(({ args, cwd }) => ({ scope: args[args.length - 1], cwd })),
    ).toEqual([
      { scope: "user", cwd: undefined },
      { scope: "project", cwd: "/project" },
      { scope: "local", cwd: "/other project" },
    ]);
    expect(
      h.calls.some(
        ({ args }) => args.includes("add") || args.includes("install"),
      ),
    ).toBe(false);
  });

  it.each(["marketplace list", "update grepmax@grepmax", "marketplace update"])(
    "does not reinstall after %s fails",
    async (fail) => {
      h.marketplaces = [{ name: "grepmax" }];
      h.installed = [{ id: "grepmax@grepmax", scope: "user" }];
      h.fail = fail;
      await install();
      expect(process.exitCode).toBe(1);
      expect(
        h.calls.some(
          ({ args }) => args.includes("remove") || args.includes("install"),
        ),
      ).toBe(false);
    },
  );

  it("refuses malformed inventory before changing configuration", async () => {
    h.invalid = true;
    await install();
    expect(process.exitCode).toBe(1);
    expect(mutations()).toEqual([]);
  });
  it("refuses an inventory with an unknown entry shape", async () => {
    h.marketplaces = [{ unexpected: "grepmax" }];
    await install();
    expect(process.exitCode).toBe(1);
    expect(mutations()).toEqual([]);
  });

  it("refuses missing project ownership before refreshing", async () => {
    h.installed = [
      { id: "grepmax@grepmax", scope: "project", projectPath: "/project" },
    ];
    h.missingProject = true;
    await install();
    expect(process.exitCode).toBe(1);
    expect(mutations()).toEqual([]);
  });

  it("leaves managed-only installations to the administrator", async () => {
    h.installed = [{ id: "grepmax@grepmax", scope: "managed" }];
    await install();
    expect(process.exitCode).toBe(0);
    expect(mutations()).toEqual([]);
  });
});
