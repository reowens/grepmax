import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_TIERS } from "../src/config";
import {
  computeEmbeddingFingerprint,
  isOnnxFallbackCompatible,
  parseEmbeddingGeneration,
  resolveEmbeddingGeneration,
} from "../src/lib/index/embedding-generation";
import {
  assertGemma2Profile,
  GEMMA2_CONTRACT_DIGEST,
  GEMMA2_MODEL,
  gemma2Document,
  gemma2Query,
} from "../src/lib/workers/embeddings/gemma2";

describe("optional Gemma generation", () => {
  it("retains the exact Granite v1 fingerprints", () => {
    for (const modelTier of ["small", "standard"]) {
      const g = resolveEmbeddingGeneration({ modelTier });
      const expected = createHash("sha256")
        .update(
          JSON.stringify([
            "gmax-embedding-generation-v1",
            g.tier,
            g.vectorDim,
            g.onnxModel,
            g.mlxModel,
            g.colbertModel,
          ]),
        )
        .digest("hex");
      expect(g.fingerprint).toBe(expected);
      expect(isOnnxFallbackCompatible(g)).toBe(true);
    }
  });
  it("binds Gemma to the contract and refuses another checkpoint or ONNX fallback", () => {
    const g = resolveEmbeddingGeneration({ modelTier: "gemma2" });
    expect(g.mlxModel).toBe(GEMMA2_MODEL);
    expect(isOnnxFallbackCompatible(g)).toBe(false);
    expect(parseEmbeddingGeneration(g)).toEqual(g);
    expect(() =>
      resolveEmbeddingGeneration({
        modelTier: "standard",
        mlxModel: GEMMA2_MODEL,
      }),
    ).toThrow(/gemma2 tier/);
    expect(computeEmbeddingFingerprint(g)).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            "gmax-embedding-generation-v1",
            g.tier,
            768,
            MODEL_TIERS.gemma2.onnxModel,
            GEMMA2_MODEL,
            g.colbertModel,
            GEMMA2_CONTRACT_DIGEST,
          ]),
        )
        .digest("hex"),
    );
    expect(() =>
      resolveEmbeddingGeneration({
        modelTier: "gemma2",
        mlxModel: "other/model",
      }),
    ).toThrow(/pinned/);
    expect(() =>
      parseEmbeddingGeneration({ ...g, fingerprint: "0".repeat(64) }),
    ).toThrow(/inconsistent/);
  });
  it("uses document and code prompts without altering ColBERT input", () => {
    expect(gemma2Query("Which README explains setup?")).toBe(
      "task: question answering | query: Which README explains setup?",
    );
    expect(gemma2Query("Find test files for retries")).toBe(
      "task: code retrieval | query: Find test files for retries",
    );
    expect(gemma2Query("How is manual memory management implemented?")).toMatch(
      /^task: code retrieval/,
    );
    expect(gemma2Document("body", "/repo/example", "src/main.ts")).toBe(
      "title: example/src/main.ts | text: body",
    );
    expect(() =>
      gemma2Document("body", "/repo/example", "../other.ts"),
    ).toThrow(/belong/);
  });
  it("requires isolated Mac GPU use while leaving Small available everywhere", () => {
    const c = { modelTier: "gemma2", embedMode: "gpu" };
    const env = {
      GMAX_GEMMA_PROFILE: "1",
      GMAX_HOME: "/tmp/isolated-gemma-fixture",
      MLX_EMBED_PORT: "18100",
    };
    expect(() => assertGemma2Profile(c, env, "darwin", "arm64")).not.toThrow();
    expect(() =>
      assertGemma2Profile(
        { modelTier: "small", embedMode: "cpu" },
        env,
        "darwin",
        "arm64",
      ),
    ).toThrow(/configured gemma2 tier/);
    for (const bad of [
      { ...env, GMAX_GEMMA_PROFILE: "0" },
      { ...env, GMAX_HOME: path.join(os.homedir(), ".gmax") },
      { ...env, MLX_EMBED_PORT: "8100" },
      { ...env, MLX_EMBED_PORT: "8101" },
      { ...env, MLX_EMBED_PORT: "8079" },
    ])
      expect(() => assertGemma2Profile(c, bad, "darwin", "arm64")).toThrow(
        /requires/,
      );
    expect(() => assertGemma2Profile(c, env, "linux", "arm64")).toThrow();
    expect(() =>
      assertGemma2Profile({ ...c, embedMode: "cpu" }, env, "darwin", "arm64"),
    ).toThrow();
    expect(() =>
      assertGemma2Profile(
        { modelTier: "small", embedMode: "cpu" },
        {},
        "linux",
        "x64",
      ),
    ).not.toThrow();
  });
});
