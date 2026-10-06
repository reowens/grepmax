import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the exact shell command and steer success/failure of `codex mcp add`.
const h = vi.hoisted(() => ({
  calls: [] as string[],
  shouldFail: false,
  inventory: [] as unknown[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    // promisify(exec) wraps this; resolve/reject via the node-style callback.
    exec: (
      cmd: string,
      opts: unknown,
      cb?: (
        err: Error | null,
        res?: { stdout: string; stderr: string },
      ) => void,
    ) => {
      const callback = (typeof opts === "function" ? opts : cb) as (
        err: Error | null,
        res?: { stdout: string; stderr: string },
      ) => void;
      h.calls.push(cmd);
      if (h.shouldFail) callback(new Error("registration failed"));
      else
        callback(null, {
          stdout:
            cmd === "codex mcp list --json" ? JSON.stringify(h.inventory) : "",
          stderr: "",
        });
    },
  };
});

// Spy on writes so we can assert AGENTS.md is (not) mutated without touching disk.
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn<(...args: unknown[]) => string>(() => {
    throw new Error("no file");
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:fs", () => ({ default: fsMock, ...fsMock }));

import { installCodex, uninstallCodex } from "../src/commands/codex";

describe("codex install", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    h.calls = [];
    h.inventory = [];
    h.shouldFail = false;
    fsMock.writeFileSync.mockClear();
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockReset();
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error("no file");
    });
    (installCodex as Command).exitOverride();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("registers the MCP server with the `--` stdio separator", async () => {
    await (installCodex as Command).parseAsync([], { from: "user" });
    expect(h.calls[1]).toBe("codex mcp add gmax -- gmax mcp");
  });

  it("does not write AGENTS.md when MCP registration fails", async () => {
    h.shouldFail = true;
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    await (installCodex as Command).parseAsync([], { from: "user" });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("writes AGENTS.md when MCP registration succeeds", async () => {
    await (installCodex as Command).parseAsync([], { from: "user" });
    const wrote = fsMock.writeFileSync.mock.calls.some((c) =>
      String(c[0]).endsWith("AGENTS.md"),
    );
    expect(wrote).toBe(true);
  });
  it("resolves custom Codex homes at call time for install and removal", async () => {
    vi.stubEnv("CODEX_HOME", "/custom codex home");
    existingAgents("# Keep me\n<!-- gmax:start -->\nold\n<!-- gmax:end -->\n");
    await installCodex.parseAsync([], { from: "user" });
    expect(fsMock.writeFileSync).toHaveBeenLastCalledWith(
      "/custom codex home/AGENTS.md",
      expect.stringContaining("# Keep me"),
    );
    await uninstallCodex.parseAsync([], { from: "user" });
    expect(fsMock.writeFileSync).toHaveBeenLastCalledWith(
      "/custom codex home/AGENTS.md",
      "# Keep me\n\n",
    );
    expect(h.calls[h.calls.length - 1]).toBe("codex mcp remove gmax");
  });
  it("preserves an existing STDIO registration and its user tool policy", async () => {
    h.inventory = [
      {
        name: "gmax",
        enabled: false,
        disabled_tools: ["investigate"],
        transport: { type: "stdio", command: "/prefix/gmax", args: ["mcp"] },
      },
    ];
    await installCodex.parseAsync([], { from: "user" });
    expect(h.calls).toEqual(["codex mcp list --json"]);
    expect(fsMock.writeFileSync).toHaveBeenCalled();
    expect(h.inventory[0]).toMatchObject({
      enabled: false,
      disabled_tools: ["investigate"],
    });
  });
  it("refuses replacing an existing different transport before writing instructions", async () => {
    h.inventory = [
      {
        name: "gmax",
        transport: { type: "streamable_http", url: "https://example.invalid" },
      },
    ];
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    await installCodex.parseAsync([], { from: "user" });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(h.calls).toEqual(["codex mcp list --json"]);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
  it("refuses malformed inventory entries before registering or writing", async () => {
    h.inventory = [{ unexpected: "gmax" }];
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    await installCodex.parseAsync([], { from: "user" });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(h.calls).toEqual(["codex mcp list --json"]);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
  function existingAgents(content: string) {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockImplementation((...args: unknown[]) =>
      String(args[0]).endsWith("AGENTS.md") ? content : "Use gmax.",
    );
  }

  it("preserves unmarked prose, frontmatter, separators, and trailing spaces", async () => {
    const content =
      "---\nteam: dev\n---\n\nUse gmax.\n\n## Deploy\nReview first.\n  ";
    existingAgents(content);
    await installCodex.parseAsync([], { from: "user" });
    const written = String(
      fsMock.writeFileSync.mock.calls[
        fsMock.writeFileSync.mock.calls.length - 1
      ]?.[1],
    );
    expect(written.startsWith(content)).toBe(true);
    expect(written.match(/<!-- gmax:start -->/g)).toHaveLength(1);
  });

  it("updates only owned blocks and collapses duplicates idempotently", async () => {
    const prefix = "# Team\nKeep trailing spaces.  \n\n";
    const between = "\n\n## Deploy\nReview first.\n\n";
    const old = "<!-- gmax:start -->\nold\n<!-- gmax:end -->";
    const suffix = "\n## Footer\nKeep me.\n";
    existingAgents(`${prefix}${old}${between}${old}${suffix}`);
    await installCodex.parseAsync([], { from: "user" });
    const written = String(
      fsMock.writeFileSync.mock.calls[
        fsMock.writeFileSync.mock.calls.length - 1
      ]?.[1],
    );
    expect(written.startsWith(prefix)).toBe(true);
    expect(written.endsWith(`${between}${suffix}`)).toBe(true);
    expect(written.match(/<!-- gmax:start -->/g)).toHaveLength(1);
    existingAgents(written);
    await installCodex.parseAsync([], { from: "user" });
    expect(
      fsMock.writeFileSync.mock.calls[
        fsMock.writeFileSync.mock.calls.length - 1
      ]?.[1],
    ).toBe(written);
  });

  it("preserves incomplete markers and following text on repeated installs", async () => {
    const content = "<!-- gmax:start -->\nUser instructions\n";
    existingAgents(content);
    await installCodex.parseAsync([], { from: "user" });
    const written = String(
      fsMock.writeFileSync.mock.calls[
        fsMock.writeFileSync.mock.calls.length - 1
      ]?.[1],
    );
    existingAgents(written);
    await installCodex.parseAsync([], { from: "user" });
    expect(
      String(
        fsMock.writeFileSync.mock.calls[
          fsMock.writeFileSync.mock.calls.length - 1
        ]?.[1],
      ).startsWith(content),
    ).toBe(true);
    expect(
      fsMock.writeFileSync.mock.calls[
        fsMock.writeFileSync.mock.calls.length - 1
      ]?.[1],
    ).toBe(written);
  });
});
