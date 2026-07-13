import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const testConfig = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  return {
    tempRoot: fs.mkdtempSync(path.join(os.tmpdir(), "gmax-config-prefs-")),
  };
});

vi.mock("../src/config", async () => {
  const actual =
    await vi.importActual<typeof import("../src/config")>("../src/config");
  return {
    ...actual,
    PATHS: {
      ...actual.PATHS,
      globalRoot: testConfig.tempRoot,
      configPath: path.join(testConfig.tempRoot, "config.json"),
    },
  };
});

import {
  readGlobalConfig,
  readIndexConfig,
  writeGlobalConfig,
  writeIndexConfig,
  writeSetupConfig,
} from "../src/lib/index/index-config";

const configPath = path.join(testConfig.tempRoot, "config.json");

beforeEach(() => {
  fs.rmSync(configPath, { force: true });
});

afterAll(() => {
  fs.rmSync(testConfig.tempRoot, { recursive: true, force: true });
});

describe("configuration preference preservation", () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("preserves queryLog=%s and llmEnabled=%s across model updates", (queryLog, llmEnabled) => {
    writeGlobalConfig({
      modelTier: "small",
      vectorDim: 384,
      embedMode: "gpu",
      queryLog,
      llmEnabled,
    });

    writeGlobalConfig({
      modelTier: "standard",
      vectorDim: 768,
      embedMode: "cpu",
    });

    expect(readGlobalConfig()).toMatchObject({
      modelTier: "standard",
      vectorDim: 768,
      embedMode: "cpu",
      queryLog,
      llmEnabled,
    });
  });

  it("preserves preferences during a full index identity write", () => {
    writeGlobalConfig({
      modelTier: "small",
      vectorDim: 384,
      embedMode: "gpu",
      queryLog: true,
      llmEnabled: true,
    });

    writeIndexConfig(configPath, { indexedAt: "2026-07-09T00:00:00.000Z" });

    expect(readIndexConfig(configPath)).toMatchObject({
      queryLog: true,
      llmEnabled: true,
      indexedAt: "2026-07-09T00:00:00.000Z",
    });
  });

  it("does not erase omitted setup preferences", () => {
    writeGlobalConfig({
      modelTier: "standard",
      vectorDim: 768,
      embedMode: "gpu",
      mlxModel: "model-a",
      queryLog: true,
      llmEnabled: false,
    });

    writeSetupConfig(configPath, { embedMode: "cpu" });

    expect(readGlobalConfig()).toMatchObject({
      modelTier: "standard",
      mlxModel: "model-a",
      embedMode: "cpu",
      queryLog: true,
      llmEnabled: false,
    });
  });

  it("clears optional setup preferences when explicitly set to undefined", () => {
    writeGlobalConfig({
      modelTier: "standard",
      vectorDim: 768,
      embedMode: "gpu",
      mlxModel: "model-a",
    });

    writeSetupConfig(configPath, {
      embedMode: "cpu",
      mlxModel: undefined,
    });

    const stored = readGlobalConfig();
    expect(stored.mlxModel).toBeUndefined();
    expect(stored.modelTier).toBe("standard");
  });
});
