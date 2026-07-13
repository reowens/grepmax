import * as fs from "node:fs";
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

const mockTable: any = {
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

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

vi.mock("../src/lib/utils/git", () => ({
  getCommitHistory: vi.fn(() => []),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
  };
});

import { log } from "../src/commands/log";
import { getCommitHistory } from "../src/lib/utils/git";

const sampleCommit = {
  hash: "abc1234567890abcdef1234567890abcdef12345",
  shortHash: "abc1234",
  author: "Robert Owens",
  isoDate: "2026-05-01T10:00:00-07:00",
  relDate: "6 days ago",
  subject: "feat: add cache invalidation",
  filesChanged: 1,
  insertions: 12,
  deletions: 3,
  numstatLines: [{ added: 12, removed: 3, path: "/tmp/project/src/auth.ts" }],
};

describe("log command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (log as Command).exitOverride();
    process.exitCode = 0;
  });

  it("path mode: prints human-formatted commits for an existing file", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: any) =>
      String(p).endsWith("src/auth.ts"),
    );
    (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
      isDirectory: () => false,
    } as any);
    (getCommitHistory as ReturnType<typeof vi.fn>).mockReturnValue([
      sampleCommit,
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (log as Command).parseAsync(["src/auth.ts"], { from: "user" });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("abc1234");
    expect(output).toContain("Robert Owens");
    expect(output).toContain("feat: add cache invalidation");
    expect(output).toContain("1 file");
    spy.mockRestore();
  });

  it("path mode --agent: TSV output", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: any) =>
      String(p).endsWith("src/auth.ts"),
    );
    (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
      isDirectory: () => false,
    } as any);
    (getCommitHistory as ReturnType<typeof vi.fn>).mockReturnValue([
      sampleCommit,
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (log as Command).parseAsync(["src/auth.ts", "--agent"], {
      from: "user",
    });
    const lines = spy.mock.calls.map((c) => String(c[0]));
    const tsvLine = lines.find((l) => l.includes("abc1234"));
    expect(tsvLine).toBeDefined();
    const fields = (tsvLine as string).split("\t");
    expect(fields[0]).toBe("abc1234");
    expect(fields[1]).toBe("2026-05-01T10:00:00-07:00");
    expect(fields[2]).toBe("Robert Owens");
    expect(fields[3]).toBe("feat: add cache invalidation");
    expect(fields[4]).toBe("1");
    expect(fields[5]).toBe("12");
    expect(fields[6]).toBe("3");
    expect(fields[7]).toBe(""); // no touchedFiles in path mode
    spy.mockRestore();
  });

  it("symbol mode: fans out across defining files and dedupes by commit", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const chain = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => [
        { path: "/tmp/project/src/a.ts" },
        { path: "/tmp/project/src/b.ts" },
        { path: "/tmp/project/src/a.ts" }, // duplicate path → dedup
      ]),
    };
    mockTable.query.mockReturnValue(chain);

    const multiFileCommit = {
      ...sampleCommit,
      numstatLines: [
        { added: 5, removed: 1, path: "/tmp/project/src/a.ts" },
        { added: 7, removed: 2, path: "/tmp/project/src/b.ts" },
      ],
    };
    (getCommitHistory as ReturnType<typeof vi.fn>).mockReturnValue([
      multiFileCommit,
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (log as Command).parseAsync(["myFunction", "--agent"], {
      from: "user",
    });

    const callArgs = (getCommitHistory as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArgs.paths).toHaveLength(2); // deduped
    expect(callArgs.paths).toContain("/tmp/project/src/a.ts");
    expect(callArgs.paths).toContain("/tmp/project/src/b.ts");
    expect(callArgs.follow).toBe(false);

    const tsvLine = spy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("abc1234"));
    expect(tsvLine).toBeDefined();
    const touchedFiles = (tsvLine as string).split("\t")[7];
    expect(touchedFiles).toContain("src/a.ts");
    expect(touchedFiles).toContain("src/b.ts");
    spy.mockRestore();
  });

  it("propagates --limit and --from to getCommitHistory", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: any) =>
      String(p).endsWith("src/auth.ts"),
    );
    (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
      isDirectory: () => false,
    } as any);
    (getCommitHistory as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (log as Command).parseAsync(
      ["src/auth.ts", "--limit", "5", "--from", "main", "--agent"],
      { from: "user" },
    );
    const callArgs = (getCommitHistory as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArgs.limit).toBe(5);
    expect(callArgs.from).toBe("main");
    spy.mockRestore();
  });

  it("directory path: forces follow=false even with default-on flag", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: any) =>
      String(p).endsWith("src/lib"),
    );
    (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
      isDirectory: () => true,
    } as any);
    (getCommitHistory as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (log as Command).parseAsync(["src/lib", "--agent"], { from: "user" });
    const callArgs = (getCommitHistory as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArgs.follow).toBe(false);
    spy.mockRestore();
  });

  it("--no-follow disables follow on a file", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: any) =>
      String(p).endsWith("src/auth.ts"),
    );
    (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
      isDirectory: () => false,
    } as any);
    (getCommitHistory as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (log as Command).parseAsync(
      ["src/auth.ts", "--no-follow", "--agent"],
      {
        from: "user",
      },
    );
    const callArgs = (getCommitHistory as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArgs.follow).toBe(false);
    spy.mockRestore();
  });

  it("missing path and unknown symbol: prints error to stderr and exits 1", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const chain = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => []),
    };
    mockTable.query.mockReturnValue(chain);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await (log as Command).parseAsync(["nope_no_match_xyz"], { from: "user" });
    const output = errSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("no file or symbol matched");
    expect(output).toContain("nope_no_match_xyz");
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});
