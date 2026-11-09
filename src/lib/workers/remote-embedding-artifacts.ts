import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { MODEL_IDS, MODEL_TIERS } from "../../config";
import { ONNX_DENSE_FILE } from "../index/embedding-generation";
import type { PreparedEmbeddingIdentity } from "./remote-embedding/protocol";

export interface PreparedEmbeddingFile {
  path: string;
  bytes: number;
  sha256: string;
}
export interface PreparedEmbeddingManifest {
  schemaVersion: 1;
  generationFingerprint: string;
  colbertDim: number;
  models: PreparedEmbeddingFile[];
  runtime: {
    platform: string;
    architecture: string;
    nodeVersion: string;
    commit: string;
    files: PreparedEmbeddingFile[];
    dependencyFiles?: PreparedEmbeddingFile[];
    links?: { path: string; target: string }[];
  };
  policy: {
    cache: "read-only";
    downloads: "forbidden";
    preprocessing: "gmax-onnx-hybrid-v1";
  };
}

// This binds the existing Granite/ColBERT document path, not the MLX route.
const preprocessing = {
  granite: `${ONNX_DENSE_FILE};cpu;1-per-call;max256;masked-mean;L2;float32`,
  colbert:
    "model_int8;cpu;1-per-call;doc512;CLS-D-text-SEP;pad50283;token-L2;round-maxabs-int8-127;mean-L2-pooled;tokenIds",
};
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function refuse(reason: string): never {
  throw new Error(`remote embedding artifacts: ${reason}`);
}
function exact(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    refuse("invalid manifest fields");
}
function safePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !value.length ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused in a path on purpose
    /[\\\x00-\x1f<>:"|?*]/.test(value) ||
    value
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    refuse("unsafe inventory path");
}
function inventory(value: unknown): PreparedEmbeddingFile[] {
  if (!Array.isArray(value) || !value.length || value.length > 32768)
    refuse("invalid inventory size");
  const names = new Set<string>();
  let total = 0;
  const result = value
    .map((entry) => {
      exact(entry, ["path", "bytes", "sha256"]);
      safePath(entry.path);
      const folded = entry.path.toLowerCase();
      if (names.has(folded)) refuse("duplicate/case-colliding inventory path");
      names.add(folded);
      if (
        !Number.isSafeInteger(entry.bytes) ||
        Number(entry.bytes) < 0 ||
        Number(entry.bytes) > 1024 ** 3 ||
        !hash(entry.sha256)
      )
        refuse("invalid inventory hash/size");
      total += Number(entry.bytes);
      if (total > 4 * 1024 ** 3) refuse("inventory exceeds byte budget");
      return {
        path: entry.path,
        bytes: Number(entry.bytes),
        sha256: entry.sha256,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}

export function validatePreparedEmbeddingManifest(
  value: unknown,
): PreparedEmbeddingManifest {
  exact(value, [
    "schemaVersion",
    "generationFingerprint",
    "colbertDim",
    "models",
    "runtime",
    "policy",
  ]);
  exact(value.policy, ["cache", "downloads", "preprocessing"]);
  const linked =
    Object.hasOwn(value.runtime as object, "dependencyFiles") ||
    Object.hasOwn(value.runtime as object, "links");
  exact(value.runtime, [
    "platform",
    "architecture",
    "nodeVersion",
    "commit",
    "files",
    ...(linked ? ["dependencyFiles", "links"] : []),
  ]);
  if (
    value.schemaVersion !== 1 ||
    !hash(value.generationFingerprint) ||
    !Number.isInteger(value.colbertDim) ||
    Number(value.colbertDim) < 1 ||
    Number(value.colbertDim) > 1024 ||
    value.policy.cache !== "read-only" ||
    value.policy.downloads !== "forbidden" ||
    value.policy.preprocessing !== "gmax-onnx-hybrid-v1" ||
    typeof value.runtime.platform !== "string" ||
    !["darwin", "win32", "linux"].includes(value.runtime.platform) ||
    typeof value.runtime.architecture !== "string" ||
    !["arm64", "x64"].includes(value.runtime.architecture) ||
    typeof value.runtime.nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.runtime.nodeVersion) ||
    typeof value.runtime.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.runtime.commit)
  )
    refuse("unsupported manifest contract");
  let closure: Pick<
    PreparedEmbeddingManifest["runtime"],
    "dependencyFiles" | "links"
  > = {};
  if (linked) {
    if (
      !Array.isArray(value.runtime.links) ||
      value.runtime.links.length > 32768
    )
      refuse("invalid dependency aliases");
    const names = new Set<string>();
    const links = value.runtime.links
      .map((raw) => {
        exact(raw, ["path", "target"]);
        safePath(raw.path);
        safePath(raw.target);
        if (
          !/^(runtime|dependencies)\//.test(raw.path) ||
          !/^(runtime|dependencies)(\/|$)/.test(raw.target) ||
          names.has(raw.path.toLowerCase())
        )
          refuse("invalid/colliding dependency alias");
        names.add(raw.path.toLowerCase());
        return { path: raw.path, target: raw.target };
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    closure = {
      dependencyFiles: inventory(value.runtime.dependencyFiles),
      links,
    };
  }
  return {
    schemaVersion: 1,
    generationFingerprint: value.generationFingerprint,
    colbertDim: Number(value.colbertDim),
    models: inventory(value.models),
    policy: {
      cache: "read-only",
      downloads: "forbidden",
      preprocessing: "gmax-onnx-hybrid-v1",
    },
    runtime: {
      platform: String(value.runtime.platform),
      architecture: String(value.runtime.architecture),
      nodeVersion: value.runtime.nodeVersion,
      commit: value.runtime.commit,
      files: inventory(value.runtime.files),
      ...closure,
    },
  };
}

export function preparedEmbeddingDigests(value: unknown) {
  const m = validatePreparedEmbeddingManifest(value);
  return {
    artifactDigest: digest([
      "gmax-embedding-artifacts-v1",
      m.generationFingerprint,
      m.colbertDim,
      m.policy,
      preprocessing,
      m.models,
    ]),
    runtimeDigest: digest(["gmax-embedding-runtime-v1", m.policy, m.runtime]),
  };
}

async function directory(location: string) {
  const absolute = path.resolve(location);
  let current = path.parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      refuse("redirected cache directory");
  }
  if ((await realpath(absolute)) !== absolute)
    refuse("cache directory escapes canonical root");
  return absolute;
}

async function verifyTree(
  root: string,
  files: PreparedEmbeddingFile[],
  aliases = new Map<string, string>(),
) {
  await directory(root);
  const expected = new Map(files.map((file) => [file.path, file]));
  let visited = 0;
  async function walk(relative: string): Promise<void> {
    const parent = path.join(root, relative);
    await directory(parent);
    for (const name of await readdir(parent)) {
      const relativeFile = relative ? `${relative}/${name}` : name;
      safePath(relativeFile);
      const absolute = path.join(root, ...relativeFile.split("/"));
      const before = await lstat(absolute);
      if (before.isSymbolicLink()) {
        const target = aliases.get(relativeFile);
        if (
          !target ||
          (await realpath(absolute)) !== target ||
          (await realpath(target)) !== target
        )
          refuse("unlisted/escaping/cyclic dependency symlink");
        aliases.delete(relativeFile);
        continue; // Its canonical target is covered by the other full inventory.
      }
      if (before.isDirectory()) {
        if (
          !files.some((file) => file.path.startsWith(relativeFile + "/")) &&
          ![...aliases.keys()].some((name) =>
            name.startsWith(relativeFile + "/"),
          )
        )
          refuse("unlisted directory");
        await walk(relativeFile);
        continue;
      }
      const wanted = expected.get(relativeFile);
      if (!before.isFile() || !wanted || before.size !== wanted.bytes)
        refuse("missing/unlisted/changed artifact");
      const file = await open(
        absolute,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = await file.stat();
        if (
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size
        )
          refuse("artifact changed before read");
        const sha = createHash("sha256"),
          buffer = Buffer.alloc(65536);
        let bytes = 0;
        for (;;) {
          const read = await file.read(buffer, 0, buffer.length, bytes);
          if (!read.bytesRead) break;
          bytes += read.bytesRead;
          if (bytes > wanted.bytes) refuse("artifact grew during read");
          sha.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await file.stat();
        if (
          bytes !== wanted.bytes ||
          sha.digest("hex") !== wanted.sha256 ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          after.ctimeMs !== opened.ctimeMs
        )
          refuse("artifact digest changed");
      } finally {
        await file.close();
      }
      if ((await realpath(absolute)) !== absolute)
        refuse("artifact escaped cache");
      const final = await lstat(absolute);
      if (
        final.isSymbolicLink() ||
        final.dev !== before.dev ||
        final.ino !== before.ino ||
        final.size !== before.size ||
        final.mtimeMs !== before.mtimeMs ||
        final.ctimeMs !== before.ctimeMs
      )
        refuse("artifact replaced during read");
      visited++;
    }
    await directory(parent);
  }
  await walk("");
  if (visited !== files.length) refuse("prepared inventory is incomplete");
  if (aliases.size) refuse("declared dependency aliases missing");
}

/** Metadata/byte verification only. Roots and manifest come from the trusted adapter. */
export async function verifyPreparedEmbeddingArtifacts(
  value: unknown,
  expected: PreparedEmbeddingIdentity,
  roots: { models: string; runtime: string; dependencies?: string },
): Promise<{ graniteModelPath: string; colbertModelPath: string }> {
  const manifest = validatePreparedEmbeddingManifest(value);
  const tier = MODEL_TIERS[expected.generation.tier];
  if (
    !["small", "standard"].includes(expected.generation.tier) ||
    !tier ||
    expected.generation.onnxModel !== tier.onnxModel ||
    expected.generation.mlxModel !== tier.mlxModel ||
    expected.generation.vectorDim !== tier.vectorDim ||
    expected.generation.colbertModel !== MODEL_IDS.colbert
  )
    refuse("unsupported prepared ONNX generation");
  const digests = preparedEmbeddingDigests(manifest);
  if (
    manifest.generationFingerprint !== expected.generation.fingerprint ||
    manifest.colbertDim !== expected.colbertDim ||
    digests.artifactDigest !== expected.artifactDigest ||
    digests.runtimeDigest !== expected.runtimeDigest
  )
    refuse("prepared identity differs");
  if (
    manifest.runtime.platform !== process.platform ||
    manifest.runtime.architecture !== process.arch ||
    manifest.runtime.nodeVersion !== process.versions.node
  )
    refuse("prepared runtime platform differs");
  const modelNames = new Set(manifest.models.map((file) => file.path));
  const granite = expected.generation.onnxModel,
    colbert = expected.generation.colbertModel;
  safePath(granite);
  safePath(colbert);
  for (const model of [granite, colbert]) {
    for (const file of [
      "tokenizer.json",
      "tokenizer_config.json",
      "config.json",
    ])
      if (!modelNames.has(`${model}/${file}`))
        refuse("required tokenizer/model metadata absent");
  }
  const graniteFile = `${granite}/onnx/${ONNX_DENSE_FILE}`;
  const colbertFile = `${colbert}/onnx/model_int8.onnx`;
  if (!modelNames.has(graniteFile) || !modelNames.has(colbertFile))
    refuse("required ONNX artifact absent");
  if (
    manifest.models.some(
      (file) =>
        !file.path.startsWith(granite + "/") &&
        !file.path.startsWith(colbert + "/"),
    )
  )
    refuse("unrelated model inventory");
  const runtimeNames = new Set(
    manifest.runtime.files.map((file) => `runtime/${file.path}`),
  );
  for (const file of manifest.runtime.dependencyFiles ?? [])
    runtimeNames.add(`dependencies/${file.path}`);
  const links = manifest.runtime.links ?? [];
  const hasRuntimeFile = (file: string) => {
    let name = `runtime/${file}`;
    const seen = new Set<string>();
    for (let hop = 0; hop <= links.length; hop++) {
      if (seen.has(name)) refuse("cyclic runtime alias");
      seen.add(name);
      const link = links
        .filter((l) => name === l.path || name.startsWith(l.path + "/"))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (!link) return runtimeNames.has(name);
      name = link.target + name.slice(link.path.length);
    }
    refuse("runtime alias chain exceeds bound");
  };
  for (const file of [
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
  ])
    if (!hasRuntimeFile(file)) refuse("required runtime inventory absent");
  const modelsRoot = await directory(roots.models),
    runtimeRoot = await directory(roots.runtime);
  if (
    modelsRoot === runtimeRoot ||
    modelsRoot.startsWith(runtimeRoot + path.sep) ||
    runtimeRoot.startsWith(modelsRoot + path.sep)
  )
    refuse("overlapping prepared roots");
  await verifyTree(modelsRoot, manifest.models);
  if (manifest.runtime.dependencyFiles) {
    if (!roots.dependencies) refuse("trusted dependency root required");
    const dependenciesRoot = await directory(roots.dependencies);
    if (
      [modelsRoot, runtimeRoot].some(
        (root) =>
          root === dependenciesRoot ||
          root.startsWith(dependenciesRoot + path.sep) ||
          dependenciesRoot.startsWith(root + path.sep),
      )
    )
      refuse("overlapping dependency root");
    const locations = { runtime: runtimeRoot, dependencies: dependenciesRoot };
    const runtimeAliases = new Map<string, string>(),
      dependencyAliases = new Map<string, string>();
    for (const link of links) {
      const [kind, ...parts] = link.path.split("/");
      const [targetKind, ...targetParts] = link.target.split("/");
      const target = path.join(
        locations[targetKind as keyof typeof locations],
        ...targetParts,
      );
      // Require canonical targets; OS realpath also refuses symlink cycles.
      if ((await realpath(target)) !== target)
        refuse("dependency alias target is not canonical");
      const targetName = link.target;
      if (
        ![...runtimeNames].some(
          (name) => name === targetName || name.startsWith(targetName + "/"),
        )
      )
        refuse("alias target has no hashed closure");
      (kind === "runtime" ? runtimeAliases : dependencyAliases).set(
        parts.join("/"),
        target,
      );
    }
    await verifyTree(runtimeRoot, manifest.runtime.files, runtimeAliases);
    await verifyTree(
      dependenciesRoot,
      manifest.runtime.dependencyFiles,
      dependencyAliases,
    );
  } else await verifyTree(runtimeRoot, manifest.runtime.files);
  return {
    graniteModelPath: path.join(modelsRoot, ...graniteFile.split("/")),
    colbertModelPath: path.join(modelsRoot, ...colbertFile.split("/")),
  };
}
