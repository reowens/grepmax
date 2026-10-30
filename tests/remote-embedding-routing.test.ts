import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RemoteEmbeddingClient, parseBackgroundEmbeddingConfig, type BackgroundEmbeddingConfig, type RemoteEmbeddingTransport } from "../src/lib/workers/remote-embedding/client";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";
import { embeddingInputDigest, validateRemoteEmbeddingRequest, validateRemoteEmbeddingResult, type RemoteEmbeddingRequest } from "../src/lib/workers/remote-embedding/protocol";
import type { ProcessFileResult } from "../src/lib/workers/orchestrator";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-remote-fake-")); roots.push(root);
  const identity = { generation: resolveEmbeddingGeneration({ modelTier: "small" }), artifactDigest: "a".repeat(64), runtimeDigest: "b".repeat(64), colbertDim: 2 };
  const config: BackgroundEmbeddingConfig = { mode: "remote", worker: "fake-worker", runtimeCheckout: root, runtimeCommit: "c".repeat(40), identity };
  const chunks = [{ id: "0", text: "formatted changed chunk" }];
  const request = validateRemoteEmbeddingRequest({ protocolVersion: 1, jobId: "job", daemonEpoch: "epoch", fileRevisionId: "hash", attemptId: "attempt", deadlineAt: Date.now()+180000, identity, chunks, inputDigest: embeddingInputDigest(chunks) });
  const reply = (r: RemoteEmbeddingRequest) => ({ ...r, chunks: undefined, vectors: [{ id: "0", dense: Array(384).fill(0), colbert: Buffer.from([127,129]).toString("base64"), scale: 1, pooled: [0,1], tokenIds: [42] }] });
  function result(r: RemoteEmbeddingRequest) { const { chunks: _chunks, deadlineAt: _deadlineAt, ...rest } = reply(r); return rest; }
  const file = { vectors: [{ id: "chunk", vector: [], colbert: [], colbert_scale: 1 }], hash: "hash", mtimeMs: 1, size: 1, remoteChunks: [{ index: 0, text: chunks[0].text }] } as ProcessFileResult;
  return { root, config, request, result, file };
}
describe("background remote boundary (unexecuted fake fixture source)", () => {
  it("defaults local and refuses incomplete remote config rather than falling back", () => {
    expect(parseBackgroundEmbeddingConfig(undefined)).toEqual({ mode: "local" });
    expect(() => parseBackgroundEmbeddingConfig({ mode: "remote", worker: "mac" })).toThrow();
  });
  it("has no production worker capability or local inference fallback", () => {
    const f=fixture(); const client=new RemoteEmbeddingClient(undefined,path.join(f.root,"custody"));
    expect(client.status(f.config).state).toBe("deferred"); expect(() => client.requireAvailable(f.config)).toThrow();
  });
  it("rejects changed digest, oversized text, stale fence and partial results", () => {
    const f=fixture(); expect(() => validateRemoteEmbeddingRequest({ ...f.request, inputDigest:"0".repeat(64) })).toThrow();
    expect(() => validateRemoteEmbeddingRequest({ ...f.request, chunks:[{id:"0",text:"x".repeat(32769)}] })).toThrow();
    expect(() => validateRemoteEmbeddingResult({ ...f.result(f.request), attemptId:"stale" },f.request)).toThrow();
    expect(() => validateRemoteEmbeddingResult({ ...f.result(f.request), vectors:[] },f.request)).toThrow();
  });
  it("atomically fills prepared vectors only after terminal cleanup proof", async () => {
    const f=fixture();const submit=vi.fn(async (r:RemoteEmbeddingRequest) => ({ result:f.result(r),terminal:true,cleanupConfirmed:true }));
    const transport:RemoteEmbeddingTransport={capability:()=>({available:true,reason:"fake only"}),submit};
    const client=new RemoteEmbeddingClient(transport,path.join(f.root,"custody"));const completed=await client.complete(f.file,f.config);
    expect(submit).toHaveBeenCalledTimes(1);expect(completed.remoteChunks).toBeUndefined();expect(completed.vectors[0].vector.length).toBe(384);expect(f.file.vectors[0].vector.length).toBe(0);
  });
  it("retains uncertain custody across controller replacement without resubmitting", async () => {
    const f=fixture();const submit=vi.fn(async () => { throw new Error("disconnect"); });
    const transport:RemoteEmbeddingTransport={capability:()=>({available:true,reason:"fake"}),submit};const custody=path.join(f.root,"custody");
    await expect(new RemoteEmbeddingClient(transport,custody).complete(f.file,f.config)).rejects.toThrow("disconnect");
    const replacement=new RemoteEmbeddingClient(transport,custody);expect(replacement.status(f.config).state).toBe("unknown");
    await expect(replacement.complete(f.file,f.config)).rejects.toThrow();expect(submit).toHaveBeenCalledTimes(1);expect(f.file.vectors[0].vector.length).toBe(0);
  });
});
