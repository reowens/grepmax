import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const readFileSync = vi.fn(() => "export const value = 1;\n");
  const symbolRows = vi.fn(async () => [] as any[]);
  const where = vi.fn().mockReturnThis();
  return {
    readFileSync,
    symbolRows,
    where,
    searchChain: {
      where,
      limit: vi.fn().mockReturnThis(),
      toArray: symbolRows,
    },
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...(actual as any),
    existsSync: vi.fn(() => true),
    realpathSync: vi.fn((p: string) => p),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
    readFileSync: mocks.readFileSync,
  };
});

vi.mock("../src/lib/setup/setup-helpers", () => ({
  ensureSetup: vi.fn(async () => {}),
}));

vi.mock("../src/lib/utils/project-root", () => ({
  findProjectRoot: vi.fn(() => "/tmp/project"),
  ensureProjectPaths: vi.fn(() => ({
    root: "/tmp/project",
    dataDir: "/tmp/.gmax",
    lancedbDir: "/tmp/.gmax/lancedb",
    cacheDir: "/tmp/.gmax/cache",
    lmdbPath: "/tmp/.gmax/cache/meta.lmdb",
    configPath: "/tmp/.gmax/config.json",
  })),
}));

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: class {
    ensureTable = vi.fn(async () => ({
      search: vi.fn(() => mocks.searchChain),
    }));
    close = vi.fn(async () => {});
  },
}));

vi.mock("../src/lib/skeleton/skeletonizer", () => ({
  Skeletonizer: class {
    init = vi.fn(async () => {});
    skeletonizeFile = vi.fn(async () => ({
      success: true,
      skeleton: "const value: number",
      tokenEstimate: 4,
    }));
  },
}));

vi.mock("../src/lib/skeleton/retriever", () => ({
  getStoredSkeleton: vi.fn(async () => null),
}));

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

vi.mock("../src/lib/utils/file-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/utils/file-utils")>()),
  readContainedTextFileSync: mocks.readFileSync,
}));

import { skeleton } from "../src/commands/skeleton";

describe("skeleton command containment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (skeleton as Command).exitOverride();
    mocks.symbolRows.mockResolvedValue([]);
  });

  it("rejects a direct file outside the selected project", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await (skeleton as Command).parseAsync(["/tmp/outside.ts"], {
      from: "user",
    });

    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Error:",
      expect.stringContaining("outside project root"),
    );
    errorSpy.mockRestore();
  });

  it("scopes symbol lookup and rejects an out-of-project stored path", async () => {
    mocks.symbolRows.mockResolvedValueOnce([
      { path: "/tmp/other/auth.ts", defined_symbols: ["handleAuth"] },
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await (skeleton as Command).parseAsync(["handleAuth"], { from: "user" });

    expect(mocks.where).toHaveBeenCalledWith(
      expect.stringContaining("/tmp/project/"),
    );
    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Error:",
      expect.stringContaining("outside project root"),
    );
    errorSpy.mockRestore();
  });
});
