import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";
import {
  preparedEmbeddingDigests, validatePreparedEmbeddingManifest, verifyPreparedEmbeddingArtifacts,
  type PreparedEmbeddingFile, type PreparedEmbeddingManifest,
} from "../src/lib/workers/remote-embedding-artifacts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gmax-artifact-fixture-")));
  const roots = { models: path.join(root, "models"), runtime: path.join(root, "runtime") };
  const generation = resolveEmbeddingGeneration({ modelTier: "small" });
  const files = async (base: string, names: string[]): Promise<PreparedEmbeddingFile[]> => {
    const entries = [];
    for (const name of names) {
      const target = path.join(base, ...name.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      const content = `fake fixture bytes: ${name}`;
      await writeFile(target, content);
      entries.push({ path: name, bytes: Buffer.byteLength(content), sha256: hash(content) });
    }
    return entries;
  };
  const manifest: PreparedEmbeddingManifest = {
    schemaVersion: 1, generationFingerprint: generation.fingerprint, colbertDim: 48,
    policy: { cache: "read-only", downloads: "forbidden", preprocessing: "gmax-onnx-hybrid-v1" },
    models: await files(roots.models, [
      ...[generation.onnxModel, generation.colbertModel].flatMap(model =>
        ["tokenizer.json", "tokenizer_config.json", "config.json"].map(name => `${model}/${name}`)),
      `${generation.onnxModel}/onnx/model_q4.onnx`, `${generation.onnxModel}/onnx/model.onnx`,
      `${generation.colbertModel}/onnx/model_int8.onnx`,
    ]),
    runtime: {
      platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node, commit: "a".repeat(40),
      files: await files(roots.runtime, ["package.json", "pnpm-lock.yaml", "src/config.ts",
        "src/lib/workers/colbert-tokenizer.ts", "src/lib/workers/embeddings/granite.ts",
        "src/lib/workers/embeddings/colbert.ts", "src/lib/workers/remote-embedding-executor.ts",
        "src/lib/workers/remote-embedding-artifacts.ts", "src/lib/workers/remote-embedding/protocol.ts",
        "src/lib/index/embedding-generation.ts", "node_modules/onnxruntime-node/package.json",
        "node_modules/@huggingface/transformers/package.json"]),
    },
  };
  const identity = () => ({ generation, colbertDim: 48, ...preparedEmbeddingDigests(manifest) });
  return { root, roots, generation, manifest, identity, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("prepared embedding artifact verifier, fake file bytes only", () => {
  it("binds complete inventories and selects Granite q4 before the float model", async () => {
    const f = await fixture();
    try {
      const result = await verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), f.roots);
      expect(result.graniteModelPath).toBe(path.join(f.roots.models, f.generation.onnxModel, "onnx/model_q4.onnx"));
      const previous = f.identity().runtimeDigest;
      f.manifest.runtime.commit = "b".repeat(40);
      expect(f.identity().runtimeDigest).not.toBe(previous);
    } finally { await f.cleanup(); }
  });

  it("rejects changed tokenizer bytes and unrelated unlisted model files", async () => {
    const f = await fixture();
    try {
      const file = path.join(f.roots.models, f.generation.onnxModel, "tokenizer.json");
      await writeFile(file, "altered tokenizer");
      await expect(verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), f.roots)).rejects.toThrow();
      await writeFile(file, `fake fixture bytes: ${f.generation.onnxModel}/tokenizer.json`);
      await writeFile(path.join(f.roots.models, "unlisted-model.onnx"), "not admitted");
      await expect(verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), f.roots)).rejects.toThrow("unlisted");
    } finally { await f.cleanup(); }
  });

  it("rejects omitted q4 precedence even when a matching float model is listed", async () => {
    const f = await fixture();
    try {
      f.manifest.models = f.manifest.models.filter(file => !file.path.endsWith("model_q4.onnx"));
      await expect(verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), f.roots)).rejects.toThrow("unlisted");
    } finally { await f.cleanup(); }
  });

  it("rejects model/cache symlinks without following their contents", async () => {
    const f = await fixture();
    try {
      const model = path.join(f.roots.models, f.generation.onnxModel, "onnx/model_q4.onnx");
      await rm(model);
      await symlink(path.join(f.roots.models, f.generation.onnxModel, "onnx/model.onnx"), model);
      await expect(verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), f.roots)).rejects.toThrow("symlink");
    } finally { await f.cleanup(); }
  });

  it("refuses digest mismatch, omitted tokenizer and download/write policy", async () => {
    const f = await fixture();
    try {
      await expect(verifyPreparedEmbeddingArtifacts(f.manifest, { ...f.identity(), artifactDigest: "c".repeat(64) }, f.roots)).rejects.toThrow("identity");
      f.manifest.models = f.manifest.models.filter(file => !file.path.endsWith("tokenizer.json"));
      await expect(verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), f.roots)).rejects.toThrow("tokenizer");
      expect(() => validatePreparedEmbeddingManifest({ ...f.manifest, policy: { ...f.manifest.policy, downloads: "allowed" } })).toThrow();
      expect(() => validatePreparedEmbeddingManifest({ ...f.manifest, models: [{ path: "../outside", bytes: 0, sha256: hash("") }] })).toThrow("unsafe");
    } finally { await f.cleanup(); }
  });
});
