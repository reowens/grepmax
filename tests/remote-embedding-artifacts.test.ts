import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";
import {
  type PreparedEmbeddingFile,
  type PreparedEmbeddingManifest,
  preparedEmbeddingDigests,
  validatePreparedEmbeddingManifest,
  verifyPreparedEmbeddingArtifacts,
} from "../src/lib/workers/remote-embedding-artifacts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "gmax-artifact-fixture-")),
  );
  const roots = {
    models: path.join(root, "models"),
    runtime: path.join(root, "runtime"),
  };
  const generation = resolveEmbeddingGeneration({ modelTier: "small" });
  const files = async (
    base: string,
    names: string[],
  ): Promise<PreparedEmbeddingFile[]> => {
    const entries = [];
    for (const name of names) {
      const target = path.join(base, ...name.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      const content = `fake fixture bytes: ${name}`;
      await writeFile(target, content);
      entries.push({
        path: name,
        bytes: Buffer.byteLength(content),
        sha256: hash(content),
      });
    }
    return entries;
  };
  const manifest: PreparedEmbeddingManifest = {
    schemaVersion: 1,
    generationFingerprint: generation.fingerprint,
    colbertDim: 48,
    policy: {
      cache: "read-only",
      downloads: "forbidden",
      preprocessing: "gmax-onnx-hybrid-v1",
    },
    models: await files(roots.models, [
      ...[generation.onnxModel, generation.colbertModel].flatMap((model) =>
        ["tokenizer.json", "tokenizer_config.json", "config.json"].map(
          (name) => `${model}/${name}`,
        ),
      ),
      `${generation.onnxModel}/onnx/model_quantized.onnx`,
      `${generation.onnxModel}/onnx/model.onnx`,
      `${generation.colbertModel}/onnx/model_int8.onnx`,
    ]),
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.versions.node,
      commit: "a".repeat(40),
      files: await files(roots.runtime, [
        "package.json",
        "pnpm-lock.yaml",
        "src/config.ts",
        "src/lib/workers/colbert-tokenizer.ts",
        "src/lib/workers/embeddings/granite.ts",
        "src/lib/workers/embeddings/colbert.ts",
        "src/lib/workers/remote-embedding-executor.ts",
        "src/lib/workers/remote-embedding-artifacts.ts",
        "src/lib/workers/remote-embedding/protocol.ts",
        "src/lib/index/embedding-generation.ts",
        "node_modules/onnxruntime-node/package.json",
        "node_modules/@huggingface/transformers/package.json",
      ]),
    },
  };
  const identity = () => ({
    generation,
    colbertDim: 48,
    ...preparedEmbeddingDigests(manifest),
  });
  return {
    root,
    roots,
    generation,
    manifest,
    identity,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("prepared embedding artifact verifier, fake file bytes only", () => {
  it("binds complete inventories and selects Granite q4 before the float model", async () => {
    const f = await fixture();
    try {
      const result = await verifyPreparedEmbeddingArtifacts(
        f.manifest,
        f.identity(),
        f.roots,
      );
      expect(result.graniteModelPath).toBe(
        path.join(
          f.roots.models,
          f.generation.onnxModel,
          "onnx/model_quantized.onnx",
        ),
      );
      const previous = f.identity().runtimeDigest;
      f.manifest.runtime.commit = "b".repeat(40);
      expect(f.identity().runtimeDigest).not.toBe(previous);
    } finally {
      await f.cleanup();
    }
  });

  it("rejects changed tokenizer bytes and unrelated unlisted model files", async () => {
    const f = await fixture();
    try {
      const file = path.join(
        f.roots.models,
        f.generation.onnxModel,
        "tokenizer.json",
      );
      await writeFile(file, "altered tokenizer");
      await expect(
        verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), f.roots),
      ).rejects.toThrow();
      await writeFile(
        file,
        `fake fixture bytes: ${f.generation.onnxModel}/tokenizer.json`,
      );
      await writeFile(
        path.join(f.roots.models, "unlisted-model.onnx"),
        "not admitted",
      );
      await expect(
        verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), f.roots),
      ).rejects.toThrow("unlisted");
    } finally {
      await f.cleanup();
    }
  });

  it("requires the int8 dense file even when a float model is listed", async () => {
    const f = await fixture();
    try {
      f.manifest.models = f.manifest.models.filter(
        (file) => !file.path.endsWith("model_quantized.onnx"),
      );
      await expect(
        verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), f.roots),
      ).rejects.toThrow("required ONNX artifact absent");
    } finally {
      await f.cleanup();
    }
  });

  it("rejects model/cache symlinks without following their contents", async () => {
    const f = await fixture();
    try {
      const model = path.join(
        f.roots.models,
        f.generation.onnxModel,
        "onnx/model_quantized.onnx",
      );
      await rm(model);
      await symlink(
        path.join(f.roots.models, f.generation.onnxModel, "onnx/model.onnx"),
        model,
      );
      await expect(
        verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), f.roots),
      ).rejects.toThrow("symlink");
    } finally {
      await f.cleanup();
    }
  });

  it("refuses digest mismatch, omitted tokenizer and download/write policy", async () => {
    const f = await fixture();
    try {
      await expect(
        verifyPreparedEmbeddingArtifacts(
          f.manifest,
          { ...f.identity(), artifactDigest: "c".repeat(64) },
          f.roots,
        ),
      ).rejects.toThrow("identity");
      f.manifest.models = f.manifest.models.filter(
        (file) => !file.path.endsWith("tokenizer.json"),
      );
      await expect(
        verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), f.roots),
      ).rejects.toThrow("tokenizer");
      expect(() =>
        validatePreparedEmbeddingManifest({
          ...f.manifest,
          policy: { ...f.manifest.policy, downloads: "allowed" },
        }),
      ).toThrow();
      expect(() =>
        validatePreparedEmbeddingManifest({
          ...f.manifest,
          models: [{ path: "../outside", bytes: 0, sha256: hash("") }],
        }),
      ).toThrow("unsafe");
    } finally {
      await f.cleanup();
    }
  });

  it("binds pnpm aliases to a fully hashed dependency closure without flattening", async () => {
    const f = await fixture();
    const dependencies = path.join(f.root, "dependencies");
    try {
      await mkdir(dependencies);
      const moved = f.manifest.runtime.files.filter((file) =>
        file.path.startsWith("node_modules/"),
      );
      f.manifest.runtime.files = f.manifest.runtime.files.filter(
        (file) => !file.path.startsWith("node_modules/"),
      );
      f.manifest.runtime.dependencyFiles = [];
      f.manifest.runtime.links = [
        { path: "runtime/node_modules", target: "dependencies" },
      ];
      for (const file of moved) {
        const name = file.path.slice("node_modules/".length);
        const physical = `.pnpm/prepared/node_modules/${name}`;
        await mkdir(path.dirname(path.join(dependencies, physical)), {
          recursive: true,
        });
        await writeFile(
          path.join(dependencies, physical),
          `fake fixture bytes: ${file.path}`,
        );
        f.manifest.runtime.dependencyFiles.push({ ...file, path: physical });
        const alias = path.dirname(name),
          target = `.pnpm/prepared/node_modules/${alias}`;
        await mkdir(path.dirname(path.join(dependencies, alias)), {
          recursive: true,
        });
        await symlink(
          path.join(dependencies, target),
          path.join(dependencies, alias),
          "junction",
        );
        f.manifest.runtime.links.push({
          path: `dependencies/${alias}`,
          target: `dependencies/${target}`,
        });
      }
      await rm(path.join(f.roots.runtime, "node_modules"), { recursive: true });
      await symlink(
        dependencies,
        path.join(f.roots.runtime, "node_modules"),
        "junction",
      );
      await expect(
        verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), {
          ...f.roots,
          dependencies,
        }),
      ).resolves.toHaveProperty("graniteModelPath");
      const before = f.identity().runtimeDigest;
      f.manifest.runtime.links[0].target = "runtime";
      expect(f.identity().runtimeDigest).not.toBe(before);
      await expect(
        verifyPreparedEmbeddingArtifacts(f.manifest, f.identity(), {
          ...f.roots,
          dependencies,
        }),
      ).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  });
});
