import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/index/index-config", () => ({
  readGlobalConfig: vi.fn(() => ({
    modelTier: "small",
    vectorDim: 384,
    embedMode: "gpu",
  })),
  readIndexConfig: vi.fn(() => ({
    indexedAt: "2026-03-23T00:00:00.000Z",
  })),
  writeGlobalConfig: vi.fn(),
  writeSetupConfig: vi.fn(),
}));

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

vi.mock("../src/lib/utils/exit", () => ({
  gracefulExit: vi.fn(async () => {}),
}));

import { config } from "../src/commands/config";
import {
  writeGlobalConfig,
  writeSetupConfig,
} from "../src/lib/index/index-config";
import { gracefulExit } from "../src/lib/utils/exit";

describe("config command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (config as Command).exitOverride();
  });

  describe("display mode", () => {
    it("shows current config when no args", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      await (config as Command).parseAsync([], { from: "user" });
      const output = spy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("small");
      expect(output).toContain("gpu");
      expect(output).toContain("384");
      spy.mockRestore();
    });

    it("shows last indexed date", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      await (config as Command).parseAsync([], { from: "user" });
      const output = spy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("2026-03-23");
      spy.mockRestore();
    });
  });

  describe("validation", () => {
    it("rejects invalid embed-mode", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await (config as Command).parseAsync(["--embed-mode", "invalid"], {
        from: "user",
      });
      const output = spy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Invalid embed mode");
      expect(writeGlobalConfig).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("rejects invalid model-tier", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await (config as Command).parseAsync(["--model-tier", "huge"], {
        from: "user",
      });
      const output = spy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Invalid model tier");
      expect(writeGlobalConfig).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("update mode", () => {
    it("writes config on valid embed-mode", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      await (config as Command).parseAsync(["--embed-mode", "cpu"], {
        from: "user",
      });
      expect(writeGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ embedMode: "cpu" }),
      );
      expect(writeSetupConfig).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("writes config on valid model-tier", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      await (config as Command).parseAsync(["--model-tier", "standard"], {
        from: "user",
      });
      expect(writeGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          modelTier: "standard",
          vectorDim: 768,
        }),
      );
      spy.mockRestore();
    });

    it("warns when model tier changes", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      await (config as Command).parseAsync(["--model-tier", "standard"], {
        from: "user",
      });
      const output = spy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Model tier changed");
      spy.mockRestore();
    });

    it("calls gracefulExit after update", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      await (config as Command).parseAsync(["--embed-mode", "cpu"], {
        from: "user",
      });
      expect(gracefulExit).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
