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

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(function () {
    return {
      listPaths: vi.fn(async () => new Map()),
      hasAnyRows: vi.fn(async () => false),
      createFTSIndex: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("../src/lib/search/searcher", () => ({
  Searcher: vi.fn(function () {
    return mockSearcher;
  }),
}));

import { search } from "../src/commands/search";
import { initialSync } from "../src/lib/index/syncer";

describe("search command", () => {
  const originalCwd = process.cwd();

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
    const _tmpDir = originalCwd;
    await (search as Command).parseAsync(["query"], { from: "user" });

    expect(initialSync).toHaveBeenCalled();
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      expect.objectContaining({ rerank: true }),
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
      expect.objectContaining({ rerank: true }),
      expect.objectContaining({ file: "syncer.ts" }),
      expect.any(String),
    );
    spy.mockRestore();
  });

  it("passes --lang as language filter", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (search as Command).parseAsync(
      ["query", "--lang", "ts", "--plain"],
      { from: "user" },
    );
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      expect.objectContaining({ rerank: true }),
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
      expect.objectContaining({ rerank: true }),
      expect.objectContaining({ role: "ORCHESTRATION" }),
      expect.any(String),
    );
    spy.mockRestore();
  });

  it("passes --exclude as exclude filter", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (search as Command).parseAsync(
      ["query", "--exclude", "tests/", "--plain"],
      { from: "user" },
    );
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      expect.objectContaining({ rerank: true }),
      expect.objectContaining({ exclude: "tests/" }),
      expect.any(String),
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
      expect.objectContaining({ rerank: true }),
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
      expect.objectContaining({ rerank: true }),
      undefined,
      expect.any(String),
    );
    spy.mockRestore();
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
