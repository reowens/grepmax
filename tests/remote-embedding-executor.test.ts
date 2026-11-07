import { describe, expect, it, vi } from "vitest";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";
import {
  describeRemoteEmbeddingWorker,
  executeRemoteEmbeddingBatch,
  type PreparedRemoteEmbeddingRuntime,
} from "../src/lib/workers/remote-embedding-executor";
import { embeddingInputDigest } from "../src/lib/workers/remote-embedding/protocol";

function fixture() {
  const identity = {
    generation: resolveEmbeddingGeneration({ modelTier: "small" }),
    artifactDigest: "a".repeat(64), runtimeDigest: "b".repeat(64), colbertDim: 2,
  };
  const chunks = [{ id: "chunk1", text: "already formatted document" }];
  const request = {
    protocolVersion: 1 as const, jobId: "job", daemonEpoch: "epoch", fileRevisionId: "revision",
    attemptId: "attempt", deadlineAt: 180001, identity, chunks, inputDigest: embeddingInputDigest(chunks),
  };
  const dense: Float32Array = new Float32Array(384).fill(0.25);
  const models = {
    granite: { runBatch: vi.fn(async (_texts: string[]) => [dense]) },
    colbert: {
      load: vi.fn(async () => {}),
      runBatch: vi.fn(async (_texts: string[], _dense: Float32Array[], _dim: number) => [{
        dense, colbert: new Int8Array([-127, 127]), scale: 0.5,
        pooled_colbert_48d: new Float32Array([0, 1]), token_ids: [42],
      }]),
    },
    dispose: vi.fn(async () => {}),
  };
  const runtime: PreparedRemoteEmbeddingRuntime = {
    identity, verifyArtifacts: vi.fn(async () => {}), createModels: vi.fn(async () => models),
  };
  return { identity, request, models, runtime, dense };
}

describe("private remote embedding executor (fake models only)", () => {
  it("uses formatted text and the existing dense then ColBERT API with unchanged packed bytes", async () => {
    const f = fixture();
    const result = await executeRemoteEmbeddingBatch(f.request, f.runtime, { now: () => 1 });
    expect(f.models.granite.runBatch).toHaveBeenCalledWith([f.request.chunks[0].text]);
    expect(f.models.colbert.runBatch).toHaveBeenCalledWith([f.request.chunks[0].text], [f.dense], 384);
    expect(result.vectors[0].colbert).toBe(Buffer.from([129, 127]).toString("base64"));
    expect(result.vectors[0].tokenIds).toEqual([42]);
    expect(result.attemptId).toBe("attempt");
    expect(f.models.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects wire authority, stale identity, and oversized input before model creation", async () => {
    const f = fixture();
    for (const request of [
      { ...f.request, command: "shell" },
      { ...f.request, identity: { ...f.identity, artifactDigest: "c".repeat(64) } },
      { ...f.request, chunks: Array.from({ length: 17 }, (_, i) => ({ id: `c${i}`, text: "text" })) },
    ]) await expect(executeRemoteEmbeddingBatch(request, f.runtime, { now: () => 1 })).rejects.toThrow();
    expect(f.runtime.createModels).not.toHaveBeenCalled();
  });

  it("verifies prepared artifacts before loading and releases an unstarted job on refusal", async () => {
    const f = fixture();
    vi.mocked(f.runtime.verifyArtifacts).mockRejectedValueOnce(new Error("missing tokenizer artifact"));
    await expect(executeRemoteEmbeddingBatch(f.request, f.runtime, { now: () => 1 })).rejects.toThrow("missing tokenizer");
    expect(f.runtime.createModels).not.toHaveBeenCalled();
    await expect(executeRemoteEmbeddingBatch(f.request, f.runtime, { now: () => 1 })).resolves.toHaveProperty("jobId", "job");
  });

  it("retains single-job ownership through native completion and disposal after cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    let finishDense!: (value: Float32Array[]) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.models.granite.runBatch.mockImplementation(() => {
      entered();
      return new Promise(resolve => { finishDense = resolve; });
    });
    let finishDispose!: () => void;
    let disposing!: () => void;
    const disposalStarted = new Promise<void>(resolve => { disposing = resolve; });
    f.models.dispose.mockImplementation(() => {
      disposing();
      return new Promise(resolve => { finishDispose = resolve; });
    });
    const pending = executeRemoteEmbeddingBatch(f.request, f.runtime, { signal: controller.signal, now: () => 1 });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await started;
    controller.abort();
    await expect(executeRemoteEmbeddingBatch(f.request, f.runtime, { now: () => 1 })).rejects.toThrow("busy");
    expect(f.models.dispose).not.toHaveBeenCalled();
    finishDense([f.dense]);
    await disposalStarted;
    await expect(executeRemoteEmbeddingBatch(f.request, f.runtime, { now: () => 1 })).rejects.toThrow("busy");
    finishDispose();
    await rejected;
    expect(f.models.colbert.runBatch).not.toHaveBeenCalled();
    f.models.dispose.mockResolvedValue(undefined);
    f.models.granite.runBatch.mockResolvedValue([f.dense]);
    await expect(executeRemoteEmbeddingBatch(f.request, f.runtime, { now: () => 1 })).resolves.toHaveProperty("jobId", "job");
  });

  it("drops full results after the deadline and rejects partial or malformed native output", async () => {
    const f = fixture();
    let time = 1;
    f.models.granite.runBatch.mockImplementationOnce(async () => { time = f.request.deadlineAt; return [f.dense]; });
    await expect(executeRemoteEmbeddingBatch(f.request, f.runtime, { now: () => time })).rejects.toThrow("deadline");
    f.models.colbert.runBatch.mockResolvedValueOnce([]);
    await expect(executeRemoteEmbeddingBatch(f.request, f.runtime, { now: () => 1 })).rejects.toThrow("partial");
    f.models.colbert.runBatch.mockResolvedValueOnce([{
      dense: f.dense, colbert: new Int8Array([1]), scale: 1,
      pooled_colbert_48d: new Float32Array([0, 1]), token_ids: [42],
    }]);
    await expect(executeRemoteEmbeddingBatch(f.request, f.runtime, { now: () => 1 })).rejects.toThrow("packed");
    expect(f.models.dispose).toHaveBeenCalledTimes(3);
  });

  it("reports unobserved readiness without inventing host failures", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      expect(describeRemoteEmbeddingWorker(platform)).toMatchObject({ readiness: "not_observed", modelsLoaded: false });
    }
  });
});
