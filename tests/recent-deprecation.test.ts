import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { recent } from "../src/commands/recent";

describe("recent command (deprecated)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (recent as Command).exitOverride();
    process.exitCode = 0;
  });

  it("prints deprecation hint to stderr and sets exit code 1", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await (recent as Command).parseAsync([], { from: "user" });
    const output = errSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("deprecated");
    expect(output).toContain("gmax log");
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it("tolerates legacy --limit flag without crashing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await (recent as Command).parseAsync(["--limit", "5"], { from: "user" });
    expect(errSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});
