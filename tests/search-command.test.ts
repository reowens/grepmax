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
    osgrepDir: "/tmp/project/.osgrep",
    lancedbDir: "/tmp/project/.osgrep/lancedb",
    cacheDir: "/tmp/project/.osgrep/cache",
    lmdbPath: "/tmp/project/.osgrep/cache/meta.lmdb",
    configPath: "/tmp/project/.osgrep/config.json",
  })),
  findProjectRoot: vi.fn(() => "/tmp/project"),
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

vi.mock("../src/lib/utils/file-utils", () => ({
  formatDenseSnippet: vi.fn((t) => t),
}));

const mockSearcher = {
  search: vi.fn(async () => ({
    data: [
      {
        metadata: { path: "/tmp/project/src/file.ts" },
        score: 1,
        type: "text",
        text: "content",
        generated_metadata: { start_line: 0, num_lines: 1 },
      },
    ],
  })),
};

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(() => ({
    listPaths: vi.fn(async () => new Map()),
    hasAnyRows: vi.fn(async () => false),
    createFTSIndex: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  })),
}));

vi.mock("../src/lib/search/searcher", () => ({
  Searcher: vi.fn(() => mockSearcher),
}));

import { search } from "../src/commands/search";
import { initialSync } from "../src/lib/index/syncer";

describe("search command", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.clearAllMocks();
    spinner.text = "";
    (search as Command).exitOverride();
  });

  it("auto-syncs when store is empty and performs search", async () => {
    const _tmpDir = originalCwd;
    await (search as Command).parseAsync(["query"], { from: "user" });

    expect(initialSync).toHaveBeenCalled();
    expect(mockSearcher.search).toHaveBeenCalledWith(
      "query",
      expect.any(Number),
      { rerank: true },
      undefined,
      "",
    );
    expect(spinner.succeed).toHaveBeenCalled();
  });
});

describe("min-score filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinner.text = "";
    (search as Command).exitOverride();
  });

  it("filters results below min-score threshold", async () => {
    // Setup mock to return results with different scores
    mockStore.search.mockResolvedValueOnce({
      data: [
        { metadata: { path: "/repo/high.ts" }, score: 0.9, type: "text", generated_metadata: { start_line: 1 } },
        { metadata: { path: "/repo/medium.ts" }, score: 0.5, type: "text", generated_metadata: { start_line: 1 } },
        { metadata: { path: "/repo/low.ts" }, score: 0.2, type: "text", generated_metadata: { start_line: 1 } },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => { });

    await (search as Command).parseAsync(["query", "--min-score", "0.6"], { from: "user" });

    // Check that only high-score result is in output
    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("high.ts");
    expect(output).not.toContain("medium.ts");
    expect(output).not.toContain("low.ts");

    consoleSpy.mockRestore();
  });

  it("shows all results when min-score is 0 (default)", async () => {
    mockStore.search.mockResolvedValueOnce({
      data: [
        { metadata: { path: "/repo/high.ts" }, score: 0.9, type: "text", generated_metadata: { start_line: 1 } },
        { metadata: { path: "/repo/low.ts" }, score: 0.1, type: "text", generated_metadata: { start_line: 1 } },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => { });

    await (search as Command).parseAsync(["query"], { from: "user" });

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("high.ts");
    expect(output).toContain("low.ts");

    consoleSpy.mockRestore();
  });

  it("returns no results message when all results are filtered out", async () => {
    mockStore.search.mockResolvedValueOnce({
      data: [
        { metadata: { path: "/repo/low.ts" }, score: 0.3, type: "text", generated_metadata: { start_line: 1 } },
      ],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => { });

    await (search as Command).parseAsync(["query", "--min-score", "0.9"], { from: "user" });

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("No results found");

    consoleSpy.mockRestore();
  });
});
