import { resolveEmbeddingGeneration } from "./lib/index/embedding-generation";
// Private fixed job entry. The admitted Platform adapter owns arguments/env.
import * as fs from "node:fs";
import * as path from "node:path";
import { executeRemoteEmbeddingBatch, describeRemoteEmbeddingWorker } from "./lib/workers/remote-embedding-executor";
import { validateRemoteEmbeddingRequest, REMOTE_EMBEDDING_LIMITS } from "./lib/workers/remote-embedding/protocol";
import { createPreparedOnnxRuntime } from "./lib/workers/remote-embedding/onnx-runtime";
import { validatePreparedEmbeddingManifest, preparedEmbeddingDigests, verifyPreparedEmbeddingArtifacts } from "./lib/workers/remote-embedding-artifacts";
async function main() {
  const read = (file: string, max: number) => {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > max) throw new Error("Invalid bounded job input");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (opened.ino !== st.ino || opened.dev !== st.dev) throw new Error("Job input changed before read");
      const bytes = Buffer.alloc(max+1); let count = 0;
      for (;;) {
        const n = fs.readSync(fd, bytes, count, bytes.length-count, count);
        if (!n) break;
        count += n;
        if (count > max) throw new Error("Job input exceeds byte bound");
      }
      const end = fs.fstatSync(fd);
      if (end.size !== count || end.mtimeMs !== opened.mtimeMs || end.ctimeMs !== opened.ctimeMs) throw new Error("Job input changed during read");
      return JSON.parse(bytes.subarray(0,count).toString("utf8")) as unknown;
    } finally { fs.closeSync(fd); }
  };
  const describe = process.argv.length === 3 && process.argv[2] === "describe";
  const manifestPath = process.env.GMAX_EMBED_MANIFEST;
  const models = process.env.GMAX_EMBED_MODELS_ROOT, runtime = process.env.GMAX_EMBED_RUNTIME_ROOT;
  if (!manifestPath || !models || !runtime) {
    if (describe) { console.log(JSON.stringify({ ...describeRemoteEmbeddingWorker(), prepared: "not_configured" })); return; }
    throw new Error("Prepared worker-local closure missing");
  }
  const manifest = validatePreparedEmbeddingManifest(read(manifestPath, 8*1024*1024));
  if (manifest.runtime.commit !== process.env.GMAX_EMBED_RUNTIME_COMMIT) throw new Error("Prepared runtime commit differs");
  if (describe) {
    const generation = ["small", "standard"].map(modelTier => resolveEmbeddingGeneration({ modelTier })).find(g => g.fingerprint === manifest.generationFingerprint);
    if (!generation) throw new Error("Prepared generation not supported");
    const identity = { generation, ...preparedEmbeddingDigests(manifest), colbertDim: manifest.colbertDim };
    await verifyPreparedEmbeddingArtifacts(manifest, identity, { models, runtime, ...(process.env.GMAX_EMBED_DEPENDENCIES_ROOT ? { dependencies: process.env.GMAX_EMBED_DEPENDENCIES_ROOT } : {}) });
    console.log(JSON.stringify({ ...describeRemoteEmbeddingWorker(), prepared: "bytes_verified", identity, inference: "unexercised" })); return;
  }
  if (process.argv.length !== 4) throw new Error("Private embedding job requires fixed input/output");
  const input = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
  if (path.basename(input) !== "embedding-input.json" || path.basename(output) !== "embeddings.json" || path.dirname(input) !== path.dirname(output)) throw new Error("Embedding job paths differ");
  const request = validateRemoteEmbeddingRequest(read(input, REMOTE_EMBEDDING_LIMITS.requestBytes));
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Embedding job stopped"));
  process.once("SIGTERM", abort); process.once("SIGINT", abort);
  try {
    const result = await executeRemoteEmbeddingBatch(request, createPreparedOnnxRuntime(manifest, request.identity, { models, runtime, ...(process.env.GMAX_EMBED_DEPENDENCIES_ROOT ? { dependencies: process.env.GMAX_EMBED_DEPENDENCIES_ROOT } : {}) }), { signal: controller.signal });
    const data = JSON.stringify(result);
    if (Buffer.byteLength(data) > REMOTE_EMBEDDING_LIMITS.resultBytes) throw new Error("Embedding result exceeds bound");
    const temp = output+".partial";
    fs.writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    if (fs.existsSync(output)) throw new Error("Embedding result already exists");
    fs.renameSync(temp, output);
  } finally { process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Embedding job failed"); process.exitCode = 75; });
