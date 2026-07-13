import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const existingPaths = new Set<string>();
const directoryPaths = new Set<string>();

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

const mockSearcher = { search: vi.fn() };
let skeletonSupported = true;
let skeletonResult = {
  success: true,
  skeleton: "function handleAuth(): boolean",
  tokenEstimate: 8,
};

vi.mock("../src/lib/search/searcher", () => ({
  Searcher: class {
    search = mockSearcher.search;
  },
}));

const mockQueryChain = {
  select: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  toArray: vi.fn(async () => []),
};

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: class {
    ensureTable = vi.fn(async () => ({
      query: vi.fn(() => mockQueryChain),
    }));
    close = vi.fn(async () => {});
  },
}));

vi.mock("../src/lib/skeleton", () => ({
  Skeletonizer: class {
    init = vi.fn(async () => {});
    isSupported = vi.fn(() => ({ supported: skeletonSupported }));
    skeletonizeFile = vi.fn(async () => skeletonResult);
  },
}));

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

vi.mock("../src/lib/utils/file-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/utils/file-utils")>()),
  readContainedTextFileSync: vi.fn(
    () => "function handleAuth() {\n  return true;\n}",
  ),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...(actual as any),
    existsSync: vi.fn((p: string) => existingPaths.has(String(p))),
    realpathSync: vi.fn((p: string) => String(p)),
    statSync: vi.fn((p: string) => ({
      isDirectory: () => directoryPaths.has(String(p)),
    })),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => "function handleAuth() {\n  return true;\n}"),
  };
});

import { context } from "../src/commands/context";

describe("context command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existingPaths.clear();
    directoryPaths.clear();
    skeletonSupported = true;
    skeletonResult = {
      success: true,
      skeleton: "function handleAuth(): boolean",
      tokenEstimate: 8,
    };
    (context as Command).exitOverride();
    mockSearcher.search.mockResolvedValue({ data: [] });
  });

  it("reports no results for empty search", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (context as Command).parseAsync(["auth system"], { from: "user" });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("No results found"),
    );
    spy.mockRestore();
  });

  it("generates context with entry points and budget", async () => {
    mockSearcher.search.mockResolvedValueOnce({
      data: [
        {
          defined_symbols: ["handleAuth"],
          role: "ORCHESTRATION",
          score: 0.9,
          metadata: { path: "/tmp/project/src/auth.ts" },
          generated_metadata: { start_line: 0, end_line: 2 },
        },
      ],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (context as Command).parseAsync(["auth system", "--budget", "4000"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain('Context: "auth system"');
    expect(output).toContain("Entry Points");
    expect(output).toContain("handleAuth");
    expect(output).toContain("Key Functions");
    expect(output).toContain("function handleAuth()");
    expect(output).toContain("File Structure");
    expect(output).toContain("function handleAuth(): boolean");
    expect(output).toContain("tokens used");
    spy.mockRestore();
  });

  it("uses deterministic file path mode without semantic search", async () => {
    existingPaths.add("/tmp/project/src/auth.ts");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await (context as Command).parseAsync(["src/auth.ts", "--budget", "4000"], {
      from: "user",
    });
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    spy.mockRestore();

    expect(mockSearcher.search).not.toHaveBeenCalled();
    expect(output).toContain('Context: "src/auth.ts"');
    expect(output).toContain("Target");
    expect(output).toContain("src/auth.ts [file]");
    expect(output).toContain("File Structure");
    expect(output).toContain("File Excerpt");
    expect(output).toContain("function handleAuth()");
  });

  it("rejects an existing path outside the selected project", async () => {
    existingPaths.add("/tmp/outside.ts");
    const readSpy = vi.mocked((await import("node:fs")).readFileSync);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await (context as Command).parseAsync(["/tmp/outside.ts"], {
      from: "user",
    });

    expect(errorSpy).toHaveBeenCalledWith(
      "Context generation failed:",
      expect.stringContaining("outside project root"),
    );
    expect(readSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
