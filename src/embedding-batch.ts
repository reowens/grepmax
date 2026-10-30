// Private fixed job entry. The admitted Platform adapter owns arguments/env.
import * as fs from "node:fs";
import * as path from "node:path";
import { executeRemoteEmbeddingBatch, describeRemoteEmbeddingWorker } from "./lib/workers/remote-embedding-executor";
import { validateRemoteEmbeddingRequest, REMOTE_EMBEDDING_LIMITS } from "./lib/workers/remote-embedding/protocol";
import { createPreparedOnnxRuntime } from "./lib/workers/remote-embedding/onnx-runtime";
import { validatePreparedEmbeddingManifest } from "./lib/workers/remote-embedding-artifacts";
async function main() {
  if (process.argv.length === 3 && process.argv[2] === "describe") {
    console.log(JSON.stringify({ ...describeRemoteEmbeddingWorker(), reason: "prepared_job_required", entry: "fixed input/output; no model loaded by describe" })); return;
  }
  if (process.argv.length !== 4) throw new Error("Private embedding job requires fixed input/output");
  const input = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
  if (path.basename(input) !== "embedding-input.json" || path.basename(output) !== "embeddings.json" || path.dirname(input) !== path.dirname(output)) throw new Error("Embedding job paths differ");
  const read = (file: string, max: number) => {
    const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || st.size > max) throw new Error("Invalid bounded job input");
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  };
  const request = validateRemoteEmbeddingRequest(read(input, REMOTE_EMBEDDING_LIMITS.requestBytes));
  const manifestPath = process.env.GMAX_EMBED_MANIFEST;
  const models = process.env.GMAX_EMBED_MODELS_ROOT, runtime = process.env.GMAX_EMBED_RUNTIME_ROOT;
  if (!manifestPath || !models || !runtime) throw new Error("Prepared worker-local closure missing");
  const manifest = validatePreparedEmbeddingManifest(read(manifestPath, 8*1024*1024));
  if (manifest.runtime.commit !== process.env.GMAX_EMBED_RUNTIME_COMMIT) throw new Error("Prepared runtime commit differs");
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Embedding job stopped"));
  process.once("SIGTERM", abort); process.once("SIGINT", abort);
  try {
    const result = await executeRemoteEmbeddingBatch(request, createPreparedOnnxRuntime(manifest, request.identity, { models, runtime }), { signal: controller.signal });
    const data = JSON.stringify(result);
    if (Buffer.byteLength(data) > REMOTE_EMBEDDING_LIMITS.resultBytes) throw new Error("Embedding result exceeds bound");
    const temp = output+".partial";
    fs.writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    if (fs.existsSync(output)) throw new Error("Embedding result already exists");
    fs.renameSync(temp, output);
  } finally { process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Embedding job failed"); process.exitCode = 75; });
