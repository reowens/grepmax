import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/project-root", () => ({
  ensureProjectPaths: vi.fn(() => ({
    root: "/tmp/project",
    dataDir: "/tmp/.gmax",
    lancedbDir: "/tmp/.gmax/lancedb",
    cacheDir: "/tmp/.gmax/cache",
    lmdbPath: "/tmp/.gmax/cache/meta.lmdb",
    configPath: "/tmp/.gmax/config.json",
  })),
  findProjectRoot: vi.fn(() => "/tmp/project"),
}));

const mockTable = {
  query: vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn(async () => []),
  })),
};

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(function () {
    return {
      ensureTable: vi.fn(async () => mockTable),
      close: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("../src/lib/search/searcher", () => ({
  Searcher: vi.fn(function () {
    return { search: vi.fn(async () => ({ data: [] })) };
  }),
}));

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

vi.mock("../src/lib/utils/git", () => ({
  getChangedFiles: vi.fn(() => []),
}));

import { diff } from "../src/commands/diff";
import { getChangedFiles } from "../src/lib/utils/git";

describe("diff command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (diff as Command).exitOverride();
  });

  it("reports no changes when git returns empty", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (diff as Command).parseAsync([], { from: "user" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("No uncommitted changes"));
    spy.mockRestore();
  });

  it("reports no changes for a ref", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (diff as Command).parseAsync(["main"], { from: "user" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("No changes found relative to main"));
    spy.mockRestore();
  });

  it("lists changed files with symbols", async () => {
    (getChangedFiles as ReturnType<typeof vi.fn>).mockReturnValue([
      "/tmp/project/src/auth.ts",
    ]);

    const chain = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => [
        { defined_symbols: ["handleAuth"], role: "ORCHESTRATION" },
      ]),
    };
    mockTable.query.mockReturnValue(chain);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (diff as Command).parseAsync([], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("1 changed file");
    expect(output).toContain("handleAuth");
    spy.mockRestore();
  });

  it("uses agent format with --agent", async () => {
    (getChangedFiles as ReturnType<typeof vi.fn>).mockReturnValue([
      "/tmp/project/src/auth.ts",
    ]);

    const chain = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => [
        { defined_symbols: ["handleAuth"], role: "ORCHESTRATION", start_line: 10 },
      ]),
    };
    mockTable.query.mockReturnValue(chain);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (diff as Command).parseAsync(["--agent"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("src/auth.ts");
    expect(output).not.toContain("changed file");
    spy.mockRestore();
  });
});
