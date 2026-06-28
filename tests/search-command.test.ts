import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spinner = {
  text: "",
  succeed: vi.fn(),
  fail: vi.fn(),
};

vi.mock("../src/lib/setup/setup-helpers", () => ({
  ensureSetup: vi.fn(async () => {}),
}));

vi.mock("../src/lib/utils/project-root", () => ({
  ensureProjectPaths: vi.fn(() => ({
    root: "/tmp/project",
    dataDir: "/tmp/project/.gmax",
    lancedbDir: "/tmp/project/.gmax/lancedb",
    cacheDir: "/tmp/project/.gmax/cache",
    lmdbPath: "/tmp/project/.gmax/cache/meta.lmdb",
    configPath: "/tmp/project/.gmax/config.json",
  })),
  findProjectRoot: vi.fn(() => "/tmp/project"),
}));

vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: vi.fn(() => ({
    root: "/tmp/project",
    name: "project",
    vectorDim: 384,
    modelTier: "small",
    embedMode: "cpu",
    lastIndexed: new Date().toISOString(),
    chunkCount: 100,
    status: "indexed",
  })),
  registerProject: vi.fn(),
}));

vi.mock("../src/lib/index/index-config", () => ({
  readGlobalConfig: vi.fn(() => ({
    vectorDim: 384,
    modelTier: "small",
    embedMode: "cpu",
  })),
}));

vi.mock("../src/lib/utils/watcher-launcher", () => ({
  launchWatcher: vi.fn(async () => ({ ok: true, pid: 9999, reused: true })),
}));

vi.mock("../src/lib/index/sync-helpers", () => ({
  createIndexingSpinner: vi.fn(() => ({
    spinner,
    onProgress: vi.fn(),
  })),
  formatDryRunSummary: vi.fn(() => "dry-run-summary"),
}));

vi.mock("../src/lib/index/syncer", () => ({
  initialSync: vi.fn(async () => ({
    processed: 1,
    indexed: 1,
    total: 1,
    failedFiles: 0,
  })),
}));

vi.mock("../src/lib/index/grammar-loader", () => ({
  ensureGrammars: vi.fn(async () => {}),
}));

vi.mock("../src/lib/utils/file-utils", () => ({
  formatDenseSnippet: vi.fn((t) => t),
}));

const mockSearcher = {
  search: vi.fn(),
};

// Shared instance so tests can steer first-run auto-index decisions.
// hasRowsForPath drives single-project mode; hasAnyRows drives cross-project.
const mockVectorDb = {
  listPaths: vi.fn(async () => new Map()),
  hasAnyRows: vi.fn(async () => false),
  hasRowsForPath: vi.fn(async () => false),
  createFTSIndex: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
};

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(function () {
    return mockVectorDb;
  }),
}));

vi.mock("../src/lib/search/searcher", () => ({
  Searcher: vi.fn(function () {
    return mockSearcher;
  }),
}));

// Force the in-process search path (no daemon), so first-run auto-index logic is
// exercised deterministically regardless of whether a daemon happens to be up.
vi.mock("../src/lib/utils/daemon-client", () => ({
  isDaemonRunning: vi.fn(async () => false),
  sendDaemonCommand: vi.fn(async () => ({ ok: false })),
  ensureDaemonRunning: vi.fn(async () => false),
  sendStreamingCommand: vi.fn(async () => ({ ok: true, type: "done" })),
}));

import { search } from "../src/commands/search";
import { initialSync } from "../src/lib/index/syncer";

describe("search command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinner.text = "";
    (search as Command).exitOverride();
    mockSearcher.search.mockResolvedValue({
      data: [
        {
          metadata: { path: "/tmp/project/src/file.ts" },
          score: 1,
          type: "text",
          text: "content",
          generated_metadata: { start_line: 0, num_lines: 1 },
        },
      ],
    });
  });

  it("auto-syncs when store is empty and performs search", async () => {
    await (search as Command).parseAsync(["query"], { from: "user" });

    expect(initialSync).toHaveBeenCalled();
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      expect.objectContaining({ rerank: false }),
      undefined,
      expect.stringMatching(/\/$/), // absolute path prefix ending with /
    );
    expect(spinner.succeed).toHaveBeenCalled();
  });
});

describe("min-score filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinner.text = "";
    (search as Command).exitOverride();
    mockSearcher.search.mockResolvedValue({ data: [] });
  });

  it("filters results below min-score threshold", async () => {
    // Setup mock to return results with different scores
    mockSearcher.search.mockResolvedValueOnce({
      data: [
        {
          metadata: { path: "/repo/high.ts" },
          score: 0.9,
          type: "text",
          generated_metadata: { start_line: 1 },
        },
        {
          metadata: { path: "/repo/medium.ts" },
          score: 0.5,
          type: "text",
          generated_metadata: { start_line: 1 },
        },
        {
          metadata: { path: "/repo/low.ts" },
          score: 0.2,
          type: "text",
          generated_metadata: { start_line: 1 },
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await (search as Command).parseAsync(["query", "--min-score", "0.6"], {
      from: "user",
    });

    // Check that only high-score result is in output
    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("high.ts");
    expect(output).not.toContain("medium.ts");
    expect(output).not.toContain("low.ts");

    consoleSpy.mockRestore();
  });

  it("shows all results when min-score is 0 (default)", async () => {
    mockSearcher.search.mockResolvedValueOnce({
      data: [
        {
          metadata: { path: "/repo/high.ts" },
          score: 0.9,
          type: "text",
          generated_metadata: { start_line: 1 },
        },
        {
          metadata: { path: "/repo/low.ts" },
          score: 0.1,
          type: "text",
          generated_metadata: { start_line: 1 },
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await (search as Command).parseAsync(["query"], { from: "user" });

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("high.ts");
    expect(output).toContain("low.ts");

    consoleSpy.mockRestore();
  });

  it("returns no results message when all results are filtered out", async () => {
    mockSearcher.search.mockResolvedValueOnce({
      data: [
        {
          metadata: { path: "/repo/low.ts" },
          score: 0.3,
          type: "text",
          generated_metadata: { start_line: 1 },
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await (search as Command).parseAsync(["query", "--min-score", "0.9"], {
      from: "user",
    });

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("No matches found");

    consoleSpy.mockRestore();
  });
});

describe("search filter passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (search as Command).exitOverride();
    mockSearcher.search.mockResolvedValue({
      data: [
        {
          metadata: { path: "/tmp/project/src/file.ts" },
          score: 1,
          type: "text",
          text: "content",
          generated_metadata: { start_line: 0, num_lines: 1 },
          defined_symbols: ["testSymbol"],
        },
      ],
    });
  });

  it("passes --file as file filter", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (search as Command).parseAsync(
      ["query", "--file", "syncer.ts", "--plain"],
      { from: "user" },
    );
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      expect.objectContaining({ rerank: false }),
      expect.objectContaining({ file: "syncer.ts" }),
      expect.any(String),
    );
    spy.mockRestore();
  });

  it("passes --lang as language filter", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (search as Command).parseAsync(["query", "--lang", "ts", "--plain"], {
      from: "user",
    });
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      expect.objectContaining({ rerank: false }),
      expect.objectContaining({ language: "ts" }),
      expect.any(String),
    );
    spy.mockRestore();
  });

  it("passes --role as role filter", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (search as Command).parseAsync(
      ["query", "--role", "ORCHESTRATION", "--plain"],
      { from: "user" },
    );
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      expect.objectContaining({ rerank: false }),
      expect.objectContaining({ role: "ORCHESTRATION" }),
      expect.any(String),
    );
    spy.mockRestore();
  });

  it("passes --exclude as resolved excludePrefixes array", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (search as Command).parseAsync(
      ["query", "--exclude", "tests/", "--plain"],
      { from: "user" },
    );
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      expect.objectContaining({ rerank: false }),
      expect.objectContaining({
        excludePrefixes: expect.arrayContaining([
          expect.stringMatching(/\/tests\/$/),
        ]),
      }),
      expect.any(String),
    );
    spy.mockRestore();
  });

  it("passes --in as resolved pathPrefix (single-in collapses)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (search as Command).parseAsync(
      ["query", "--in", "packages/api", "--plain"],
      { from: "user" },
    );
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      expect.objectContaining({ rerank: false }),
      undefined,
      expect.stringMatching(/\/packages\/api\/$/),
    );
    spy.mockRestore();
  });

  it("composes multiple filters", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (search as Command).parseAsync(
      ["query", "--lang", "ts", "--role", "ORCHESTRATION", "--plain"],
      { from: "user" },
    );
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      expect.objectContaining({ rerank: false }),
      expect.objectContaining({ language: "ts", role: "ORCHESTRATION" }),
      expect.any(String),
    );
    spy.mockRestore();
  });

  it("passes undefined filters when no filter flags", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (search as Command).parseAsync(["query", "--plain"], {
      from: "user",
    });
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      expect.objectContaining({ rerank: false }),
      undefined,
      expect.any(String),
    );
    spy.mockRestore();
  });
});

describe("agent file-level grouping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinner.text = "";
    (search as Command).exitOverride();
  });

  it("groups multiple hits in the same file under one header", async () => {
    mockSearcher.search.mockResolvedValueOnce({
      data: [
        {
          path: "/tmp/project/src/dup.ts",
          score: 0.9,
          start_line: 9,
          defined_symbols: ["alpha"],
          role: "DEFINITION",
          text: "export function alpha() { return 1; }",
        },
        {
          path: "/tmp/project/src/dup.ts",
          score: 0.7,
          start_line: 19,
          defined_symbols: ["beta"],
          role: "DEFINITION",
          text: "export function beta() { return 2; }",
        },
        {
          path: "/tmp/project/src/solo.ts",
          score: 0.5,
          start_line: 4,
          defined_symbols: ["gamma"],
          role: "DEFINITION",
          text: "export function gamma() { return 3; }",
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (search as Command).parseAsync(["query", "--agent"], {
      from: "user",
    });
    const lines = consoleSpy.mock.calls.map((c) => String(c[0]));
    consoleSpy.mockRestore();

    const out = lines.join("\n");
    expect(out).toContain("src/dup.ts (2 hits):");
    // children indented and path-stripped
    expect(out).toMatch(/ {2}:10\ts=0\.900 alpha \[DEFI\]/);
    expect(out).toMatch(/ {2}:20\ts=0\.700 beta \[DEFI\]/);
    // single-hit file unchanged
    expect(out).toContain("src/solo.ts:5\ts=0.500 gamma [DEFI]");
    // no group header on the single-hit file
    expect(out).not.toContain("src/solo.ts (1 hits):");
  });

  it("renders flat (no headers) when every file has exactly one hit", async () => {
    mockSearcher.search.mockResolvedValueOnce({
      data: [
        {
          path: "/tmp/project/src/a.ts",
          score: 0.9,
          start_line: 4,
          defined_symbols: ["a"],
          role: "DEFINITION",
          text: "export const a = 1;",
        },
        {
          path: "/tmp/project/src/b.ts",
          score: 0.7,
          start_line: 9,
          defined_symbols: ["b"],
          role: "DEFINITION",
          text: "export const b = 2;",
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (search as Command).parseAsync(["query", "--agent"], {
      from: "user",
    });
    const out = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    consoleSpy.mockRestore();

    expect(out).not.toContain("hits):");
    expect(out).toContain("src/a.ts:5");
    expect(out).toContain("src/b.ts:10");
  });
});

describe("unknown option handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinner.text = "";
    (search as Command).exitOverride();
  });

  it("rejects unknown options instead of misparsing them as arguments", async () => {
    // Before fix: --json was treated as pattern, "query" as path
    // After fix: Commander properly rejects unknown options
    await expect(
      (search as Command).parseAsync(["--json", "query", "."], {
        from: "user",
      }),
    ).rejects.toThrow(/unknown option/i);
  });

  it("rejects unknown options even when placed after arguments", async () => {
    await expect(
      (search as Command).parseAsync(["query", ".", "--json"], {
        from: "user",
      }),
    ).rejects.toThrow(/unknown option/i);
  });

  it("rejects excess arguments", async () => {
    await expect(
      (search as Command).parseAsync(["query", ".", "extra", "args"], {
        from: "user",
      }),
    ).rejects.toThrow(/too many arguments/i);
  });

  it("rejects multiple unknown options", async () => {
    await expect(
      (search as Command).parseAsync(["--json", "--xml", "query", "."], {
        from: "user",
      }),
    ).rejects.toThrow(/unknown option/i);
  });

  it("rejects unknown options mixed with valid options", async () => {
    await expect(
      (search as Command).parseAsync(["query", "--no-rerank", "--json", "."], {
        from: "user",
      }),
    ).rejects.toThrow(/unknown option/i);
  });

  it("rejects unknown options with equals sign", async () => {
    await expect(
      (search as Command).parseAsync(["--json=true", "query", "."], {
        from: "user",
      }),
    ).rejects.toThrow(/unknown option/i);
  });

  it("rejects short unknown options", async () => {
    await expect(
      (search as Command).parseAsync(["-j", "query", "."], { from: "user" }),
    ).rejects.toThrow(/unknown option/i);
  });

  it("rejects unknown option that looks like a path", async () => {
    await expect(
      (search as Command).parseAsync(["--./path", "query"], { from: "user" }),
    ).rejects.toThrow(/unknown option/i);
  });

  it("accepts valid options without error", async () => {
    // Regression: ensure known options still work
    await expect(
      (search as Command).parseAsync(["query", ".", "-m", "5", "--compact"], {
        from: "user",
      }),
    ).resolves.not.toThrow();
  });

  it("allows pattern starting with dash using -- separator", async () => {
    // Standard CLI convention: -- ends option parsing
    await expect(
      (search as Command).parseAsync(["--", "-pattern-with-dash", "."], {
        from: "user",
      }),
    ).resolves.not.toThrow();
  });
});

describe("first-run auto-index scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinner.text = "";
    (search as Command).exitOverride();
    mockSearcher.search.mockResolvedValue({ data: [] });
    // Reset to defaults; individual tests override.
    mockVectorDb.hasRowsForPath.mockResolvedValue(false);
    mockVectorDb.hasAnyRows.mockResolvedValue(false);
  });

  it("triggers initial sync when the searched project has no rows even if siblings do", async () => {
    // The store is centralized: a sibling project's rows (hasAnyRows -> true)
    // must NOT suppress this project's first-run index. The decision is scoped
    // to the searched project (hasRowsForPath -> false).
    mockVectorDb.hasAnyRows.mockResolvedValue(true);
    mockVectorDb.hasRowsForPath.mockResolvedValue(false);

    await (search as Command).parseAsync(["query"], { from: "user" });

    expect(mockVectorDb.hasRowsForPath).toHaveBeenCalledWith("/tmp/project");
    expect(initialSync).toHaveBeenCalled();
  });

  it("does not auto-sync when the current project already has rows", async () => {
    mockVectorDb.hasRowsForPath.mockResolvedValue(true);

    await (search as Command).parseAsync(["query"], { from: "user" });

    expect(initialSync).not.toHaveBeenCalled();
    expect(mockSearcher.search).toHaveBeenCalled();
  });

  it("auto-syncs an already-indexed project when --sync is passed", async () => {
    mockVectorDb.hasRowsForPath.mockResolvedValue(true);

    await (search as Command).parseAsync(["query", "--sync"], { from: "user" });

    expect(initialSync).toHaveBeenCalled();
  });
});
