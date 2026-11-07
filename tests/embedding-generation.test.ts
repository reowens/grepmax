import { describe, expect, it } from "vitest";
import { MODEL_IDS, MODEL_TIERS } from "../src/config";
import {
  compareEmbeddingGeneration,
  computeEmbeddingFingerprint,
  isOnnxFallbackCompatible,
  parseEmbeddingGeneration,
  resolveEmbeddingGeneration,
} from "../src/lib/index/embedding-generation";

describe("resolveEmbeddingGeneration", () => {
  it("resolves and freezes the canonical tier identity", () => {
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });

    expect(generation).toMatchObject({
      tier: "small",
      vectorDim: MODEL_TIERS.small.vectorDim,
      onnxModel: MODEL_TIERS.small.onnxModel,
      mlxModel: MODEL_TIERS.small.mlxModel,
      colbertModel: MODEL_IDS.colbert,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.isFrozen(generation)).toBe(true);
  });

  it("is deterministic and independent of input property order", () => {
    const first = resolveEmbeddingGeneration({
      modelTier: "small",
      vectorDim: 384,
      mlxModel: "custom/mlx",
    });
    const second = resolveEmbeddingGeneration({
      mlxModel: "custom/mlx",
      vectorDim: 384,
      modelTier: "small",
    });

    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("rejects an unknown tier", () => {
    expect(() => resolveEmbeddingGeneration({ modelTier: "unknown" })).toThrow(
      /unknown model tier/i,
    );
  });

  it("rejects a vector dimension that contradicts the tier", () => {
    expect(() =>
      resolveEmbeddingGeneration({ modelTier: "small", vectorDim: 768 }),
    ).toThrow(/contradicts model tier/i);
  });

  it("rejects an empty effective MLX model", () => {
    expect(() =>
      resolveEmbeddingGeneration({ modelTier: "small", mlxModel: "  " }),
    ).toThrow(/mlx model/i);
  });

  it("rejects surrounding whitespace instead of hashing a different identity", () => {
    expect(() =>
      computeEmbeddingFingerprint({
        tier: "small",
        vectorDim: 384,
        onnxModel: " onnx/a",
        mlxModel: "mlx/a",
        colbertModel: "colbert/a",
      }),
    ).toThrow(/surrounding whitespace/i);
  });

  it("parses only a coherent serialized generation", () => {
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    expect(
      parseEmbeddingGeneration(JSON.parse(JSON.stringify(generation))),
    ).toEqual(generation);
    expect(() =>
      parseEmbeddingGeneration({ ...generation, onnxModel: "wrong/model" }),
    ).toThrow(/inconsistent/i);
  });

  it("parses a coherent historical generation without current tier mappings", () => {
    const identity = {
      tier: "retired-tier",
      vectorDim: 512,
      onnxModel: "historical/onnx",
      mlxModel: "historical/mlx",
      colbertModel: "historical/colbert",
    };
    const historical = {
      ...identity,
      fingerprint: computeEmbeddingFingerprint(identity),
    };

    expect(parseEmbeddingGeneration(historical)).toEqual(historical);
  });

  it("compares a complete persisted identity using its historical model IDs", () => {
    const configured = resolveEmbeddingGeneration({ modelTier: "small" });
    const identity = {
      tier: "small",
      vectorDim: configured.vectorDim,
      onnxModel: "historical/onnx",
      mlxModel: "historical/mlx",
      colbertModel: "historical/colbert",
    };
    const fingerprint = computeEmbeddingFingerprint(identity);
    const comparison = compareEmbeddingGeneration(
      {
        modelTier: identity.tier,
        vectorDim: identity.vectorDim,
        embedModel: identity.onnxModel,
        mlxModel: identity.mlxModel,
        colbertModel: identity.colbertModel,
        embeddingFingerprint: fingerprint,
      },
      configured,
    );

    expect(comparison.built).toEqual({ ...identity, fingerprint });
    expect(comparison.state).toBe("stale");
  });

  it("allows ONNX fallback only for the tier's default compatible pair", () => {
    const generation = resolveEmbeddingGeneration({ modelTier: "small" });
    const custom = resolveEmbeddingGeneration({
      modelTier: "small",
      mlxModel: "custom/mlx",
    });

    expect(isOnnxFallbackCompatible(generation)).toBe(true);
    expect(isOnnxFallbackCompatible(custom)).toBe(false);
  });

  it("distinguishes legacy, current, and stale project identities", () => {
    const small = resolveEmbeddingGeneration({ modelTier: "small" });
    const standard = resolveEmbeddingGeneration({ modelTier: "standard" });
    expect(
      compareEmbeddingGeneration({ modelTier: "small", vectorDim: 384 }, small)
        .state,
    ).toBe("legacy");
    expect(
      compareEmbeddingGeneration(
        {
          modelTier: "small",
          vectorDim: 384,
          embeddingFingerprint: small.fingerprint,
        },
        small,
      ).state,
    ).toBe("current");
    expect(
      compareEmbeddingGeneration(
        { modelTier: "small", vectorDim: 384 },
        standard,
      ).state,
    ).toBe("stale");
  });
});

describe("computeEmbeddingFingerprint", () => {
  const base = {
    tier: "small",
    vectorDim: 384,
    onnxModel: "onnx/a",
    mlxModel: "mlx/a",
    colbertModel: "colbert/a",
  };

  it("keeps the v1 canonical digest stable", () => {
    expect(computeEmbeddingFingerprint(base)).toBe(
      "20457a6aee0f1a77c2a8edb9a39066193e48487700afc42ca6fa0640d47cf966",
    );
  });

  it.each([
    ["tier", "standard"],
    ["vectorDim", 768],
    ["onnxModel", "onnx/b"],
    ["mlxModel", "mlx/b"],
    ["colbertModel", "colbert/b"],
  ] as const)("changes when %s changes", (field, value) => {
    expect(computeEmbeddingFingerprint({ ...base, [field]: value })).not.toBe(
      computeEmbeddingFingerprint(base),
    );
  });
});
