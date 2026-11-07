import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareEmbeddingGeneration,
  isOnnxFallbackCompatible,
  ONNX_DENSE_FILE,
  ONNX_PROFILE,
  parseEmbeddingGeneration,
  resolveEmbeddingGeneration,
} from "../src/lib/index/embedding-generation";
import { GraniteModel } from "../src/lib/workers/embeddings/granite";

// A store written before the ONNX profile: q4 dense, ColBERT in batches of 16.
const before = {
  modelTier: "small",
  vectorDim: 384,
  embedModel: "onnx-community/granite-embedding-small-english-r2-ONNX",
  mlxModel: "ibm-granite/granite-embedding-small-english-r2",
  colbertModel: "ryandono/mxbai-edge-colbert-v0-17m-onnx-int8",
  embeddingFingerprint:
    "cc340c3dd6f2967512f793457deadd6dd8f2574ec09f0a63bda0f41035d15f68",
};

describe("ONNX profile in the embedding identity", () => {
  it("names the int8 dense file and ColBERT 1 chunk per call", () => {
    expect(ONNX_DENSE_FILE).toBe("model_quantized.onnx");
    expect(ONNX_PROFILE).toBe("dense=model_quantized.onnx;colbert=1-per-call");
    expect(resolveEmbeddingGeneration({ modelTier: "small" }).onnxProfile).toBe(
      ONNX_PROFILE,
    );
  });

  it("reads a store written before the profile as stale, not invalid", () => {
    const configured = resolveEmbeddingGeneration({ modelTier: "small" });
    const comparison = compareEmbeddingGeneration(before, configured);
    expect(comparison.state).toBe("stale");
    expect(comparison.built.fingerprint).toBe(before.embeddingFingerprint);
    expect(comparison.built.onnxProfile).toBeUndefined();
    expect(configured.fingerprint).not.toBe(before.embeddingFingerprint);
  });

  it("reads a store stamped with the profile as current", () => {
    const configured = resolveEmbeddingGeneration({ modelTier: "small" });
    const comparison = compareEmbeddingGeneration(
      {
        ...before,
        onnxProfile: configured.onnxProfile,
        embeddingFingerprint: configured.fingerprint,
      },
      configured,
    );
    expect(comparison.state).toBe("current");
  });

  it("refuses a profile that does not match its fingerprint", () => {
    const configured = resolveEmbeddingGeneration({ modelTier: "small" });
    expect(() =>
      parseEmbeddingGeneration({ ...configured, onnxProfile: "dense=model_q4.onnx" }),
    ).toThrow(/inconsistent/);
  });

  it("allows no ONNX embedding for a generation without the profile", () => {
    const old = resolveEmbeddingGeneration({
      modelTier: "small",
      onnxProfile: null,
    });
    expect(old.fingerprint).toBe(before.embeddingFingerprint);
    expect(isOnnxFallbackCompatible(old)).toBe(false);
  });

  it("registry accepts a pre-profile record and round-trips a stamped one", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-profile-"));
    const prev = process.env.GMAX_HOME;
    process.env.GMAX_HOME = home;
    try {
      const { vi } = await import("vitest");
      vi.resetModules();
      const registry = await import("../src/lib/utils/project-registry");
      const configured = resolveEmbeddingGeneration({ modelTier: "small" });
      const entry = {
        root: "/work/old",
        name: "old",
        embedMode: "cpu",
        lastIndexed: "2026-11-07T00:00:00.000Z",
        status: "indexed" as const,
        ...before,
      };
      fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify([entry]));
      expect(registry.listProjects()).toHaveLength(1);
      registry.registerProject({
        ...entry,
        root: "/work/new",
        name: "new",
        onnxProfile: configured.onnxProfile,
        embeddingFingerprint: configured.fingerprint,
      });
      const stored = registry.getProject("/work/new");
      expect(stored?.onnxProfile).toBe(ONNX_PROFILE);
      expect(stored?.embeddingFingerprint).toBe(configured.fingerprint);
    } finally {
      if (prev === undefined) delete process.env.GMAX_HOME;
      else process.env.GMAX_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Granite dense weights file", () => {
  const modelId = "org/granite";
  const cache = (files: string[]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-granite-"));
    fs.mkdirSync(path.join(root, modelId, "onnx"), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(root, modelId, "onnx", f), "");
    return root;
  };

  it("loads the int8 file even when q4 and fp32 sit beside it", () => {
    const root = cache(["model_q4.onnx", "model.onnx", ONNX_DENSE_FILE]);
    try {
      const model = new GraniteModel(384, modelId, root) as any;
      expect(model.resolvePaths().modelPath).toBe(
        path.join(root, modelId, "onnx", ONNX_DENSE_FILE),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to fall back to another weights file", () => {
    const root = cache(["model_q4.onnx", "model.onnx"]);
    try {
      const model = new GraniteModel(384, modelId, root) as any;
      expect(() => model.resolvePaths()).toThrow(/model_quantized\.onnx/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
