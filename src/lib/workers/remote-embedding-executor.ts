import type { HybridResult } from "./embeddings/colbert";
import {
  validatePreparedEmbeddingIdentity,
  validateRemoteEmbeddingRequest,
  validateRemoteEmbeddingResult,
  type PreparedEmbeddingIdentity,
  type RemoteEmbeddingResult,
} from "./remote-embedding/protocol";

/** Supplied by the trusted worker adapter, never reconstructed from wire data. */
export interface PreparedRemoteEmbeddingRuntime {
  identity: PreparedEmbeddingIdentity;
  /** Verify exact prepared model/tokenizer/preprocessing and runtime bytes. */
  verifyArtifacts(): Promise<void>;
  /** Offline, read-only prepared cache; reuse these sessions within this job. */
  createModels(): Promise<{
    granite: { runBatch(texts: string[]): Promise<Float32Array[]> };
    colbert: {
      load(): Promise<void>;
      runBatch(texts: string[], dense: Float32Array[], dim: number): Promise<HybridResult[]>;
    };
    /** Dispose only this job's sessions after all native calls have settled. */
    dispose(): Promise<void>;
  }>;
}

let active = false;

export function describeRemoteEmbeddingWorker(platform: string = process.platform) {
  return {
    task: "embed-batch",
    protocolVersion: 1,
    readiness: "not_observed",
    modelsLoaded: false,
    platform,
    reason: "fixed_job_preparation_and_admission_required",
    modelLifetime: "one-shot job; sessions reused within batch, cold start per job",
    requirements: [
      "trusted fixed-task adapter: Windows pre-exec 2-CPU affinity/below-normal; Mac nice10 and sampled 2-core-time throttle",
      "2-GiB aggregate owned RSS, 180-second total deadline, 8-GiB native available-memory floor",
      "whole owned-child cleanup and terminal receipt before reservation release",
      "read-only exact model/tokenizer/preprocessing/runtime inventory and digest verification, offline loading",
      "Windows Job Object commit limits alone do not enforce RSS or prove zero pagefile use",
      "Mac uses its owned process-group adapter; actual route admission and native behavior are not observed",
    ],
  } as const;
}

export async function executeRemoteEmbeddingBatch(
  value: unknown,
  runtime: PreparedRemoteEmbeddingRuntime,
  { signal, now = Date.now }: { signal?: AbortSignal; now?: () => number } = {},
): Promise<RemoteEmbeddingResult> {
  if (active) throw new Error("remote embedding: executor busy");
  const request = validateRemoteEmbeddingRequest(value, now());
  const identity = validatePreparedEmbeddingIdentity(runtime.identity);
  if (JSON.stringify(identity) !== JSON.stringify(request.identity))
    throw new Error("remote embedding: prepared identity differs");
  const check = () => {
    if (signal?.aborted) throw new Error("remote embedding: cancelled");
    if (now() >= request.deadlineAt) throw new Error("remote embedding: deadline reached");
  };
  check();
  active = true;
  let modelCreationStarted = false;
  let operationFailed = false;
  let models: Awaited<ReturnType<PreparedRemoteEmbeddingRuntime["createModels"]>> | undefined;
  try {
    await runtime.verifyArtifacts();
    check();
    modelCreationStarted = true;
    models = await runtime.createModels();
    check();
    await models.colbert.load();
    check();
    const texts = request.chunks.map(chunk => chunk.text);
    const dense = await models.granite.runBatch(texts);
    check();
    if (dense.length !== texts.length) throw new Error("remote embedding: partial dense batch");
    const hybrids = await models.colbert.runBatch(texts, dense, identity.generation.vectorDim);
    check();
    if (hybrids.length !== texts.length) throw new Error("remote embedding: partial hybrid batch");
    // Bound conversion/allocation before constructing the JSON representation.
    for (const hybrid of hybrids) {
      const tokens = hybrid.token_ids?.length ?? 0;
      if (!(hybrid.dense instanceof Float32Array) || hybrid.dense.length !== identity.generation.vectorDim
        || !(hybrid.colbert instanceof Int8Array) || tokens < 1 || tokens > 512
        || hybrid.colbert.length !== tokens * identity.colbertDim
        || !(hybrid.pooled_colbert_48d instanceof Float32Array)
        || hybrid.pooled_colbert_48d.length !== identity.colbertDim)
        throw new Error("remote embedding: invalid packed hybrid dimensions");
    }
    const result = validateRemoteEmbeddingResult({
      protocolVersion: request.protocolVersion,
      jobId: request.jobId,
      daemonEpoch: request.daemonEpoch,
      fileRevisionId: request.fileRevisionId,
      attemptId: request.attemptId,
      inputDigest: request.inputDigest,
      identity,
      vectors: hybrids.map((hybrid, i) => ({
        id: request.chunks[i].id,
        dense: Array.from(hybrid.dense),
        colbert: Buffer.from(hybrid.colbert.buffer, hybrid.colbert.byteOffset, hybrid.colbert.byteLength).toString("base64"),
        scale: hybrid.scale,
        pooled: Array.from(hybrid.pooled_colbert_48d ?? []),
        tokenIds: hybrid.token_ids ?? [],
      })),
    }, request);
    check();
    return result;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    // Never race a native call with cancellation or release another job's slot.
    // A failed disposal leaves this process unavailable until owned job exit.
    let cleaned = !modelCreationStarted;
    try {
      if (models) { await models.dispose(); cleaned = true; }
    } catch (error) {
      if (!operationFailed) throw error;
    }
    // A factory failure can leave partially initialized native state without a
    // disposal handle. Only owned process exit proves cleanup in that case.
    if (cleaned) active = false;
    if (!operationFailed) check();
  }
}
