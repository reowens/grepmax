import { createHash } from "node:crypto";
import { parseEmbeddingGeneration, type EmbeddingGenerationConfig } from "../../index/embedding-generation";

export const REMOTE_EMBEDDING_PROTOCOL = 1;
export const REMOTE_EMBEDDING_LIMITS = Object.freeze({ chunks: 16, chunkBytes: 32768, textBytes: 524288, requestBytes: 1048576, resultBytes: 12582912, tokens: 512, deadlineMs: 180000 });
export interface PreparedEmbeddingIdentity {
  generation: EmbeddingGenerationConfig;
  artifactDigest: string;
  runtimeDigest: string;
  colbertDim: number;
}
export interface RemoteEmbeddingChunk { id: string; text: string }
export interface RemoteEmbeddingRequest {
  protocolVersion: 1;
  jobId: string;
  daemonEpoch: string;
  fileRevisionId: string;
  attemptId: string;
  deadlineAt: number;
  identity: PreparedEmbeddingIdentity;
  chunks: RemoteEmbeddingChunk[];
  inputDigest: string;
}
export interface RemoteEmbeddingVector {
  id: string;
  dense: number[];
  colbert: string;
  scale: number;
  pooled: number[];
  tokenIds: number[];
}
export interface RemoteEmbeddingResult {
  protocolVersion: 1;
  jobId: string;
  daemonEpoch: string;
  fileRevisionId: string;
  attemptId: string;
  inputDigest: string;
  identity: PreparedEmbeddingIdentity;
  vectors: RemoteEmbeddingVector[];
}
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("remote embedding: object required");
  return v as Record<string, unknown>;
}
function exact(v: Record<string, unknown>, keys: string[]) {
  if (Object.keys(v).sort().join() !== keys.sort().join()) throw new Error("remote embedding: unexpected fields");
}
export function validatePreparedEmbeddingIdentity(value: unknown): PreparedEmbeddingIdentity {
  const v = object(value); exact(v, ["generation", "artifactDigest", "runtimeDigest", "colbertDim"]);
  const generation = parseEmbeddingGeneration(v.generation);
  if (!["small", "standard"].includes(generation.tier) || !hash(v.artifactDigest) || !hash(v.runtimeDigest) || !Number.isInteger(v.colbertDim) || Number(v.colbertDim) < 1 || Number(v.colbertDim) > 1024) throw new Error("remote embedding: unsupported identity");
  return { generation: { tier: generation.tier, vectorDim: generation.vectorDim, onnxModel: generation.onnxModel, mlxModel: generation.mlxModel, colbertModel: generation.colbertModel, fingerprint: generation.fingerprint }, artifactDigest: v.artifactDigest, runtimeDigest: v.runtimeDigest, colbertDim: Number(v.colbertDim) };
}
export function embeddingInputDigest(chunks: RemoteEmbeddingChunk[]): string {
  return createHash("sha256").update(JSON.stringify(chunks.map(c => [c.id, c.text]))).digest("hex");
}
export function validateRemoteEmbeddingRequest(value: unknown, now = Date.now()): RemoteEmbeddingRequest {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > REMOTE_EMBEDDING_LIMITS.requestBytes) throw new Error("remote embedding: request too large");
  const v = object(value); exact(v, ["protocolVersion", "jobId", "daemonEpoch", "fileRevisionId", "attemptId", "deadlineAt", "identity", "chunks", "inputDigest"]);
  if (v.protocolVersion !== 1 || ![v.jobId, v.daemonEpoch, v.fileRevisionId, v.attemptId].every(id) || !Number.isSafeInteger(v.deadlineAt) || Number(v.deadlineAt) <= now || Number(v.deadlineAt) > now + REMOTE_EMBEDDING_LIMITS.deadlineMs || !Array.isArray(v.chunks) || v.chunks.length < 1 || v.chunks.length > 16) throw new Error("remote embedding: invalid request fence/budget");
  const chunks = v.chunks.map(raw => { const c = object(raw); exact(c, ["id", "text"]); if (!id(c.id) || typeof c.text !== "string" || Buffer.byteLength(c.text) > REMOTE_EMBEDDING_LIMITS.chunkBytes) throw new Error("remote embedding: invalid chunk"); return { id: c.id, text: c.text }; });
  if (new Set(chunks.map(c => c.id)).size !== chunks.length || chunks.reduce((n,c) => n+Buffer.byteLength(c.text), 0) > REMOTE_EMBEDDING_LIMITS.textBytes || v.inputDigest !== embeddingInputDigest(chunks)) throw new Error("remote embedding: input digest/size differs");
  return { ...v, identity: validatePreparedEmbeddingIdentity(v.identity), chunks } as unknown as RemoteEmbeddingRequest;
}
export function validateRemoteEmbeddingResult(value: unknown, request: RemoteEmbeddingRequest): RemoteEmbeddingResult {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > REMOTE_EMBEDDING_LIMITS.resultBytes) throw new Error("remote embedding: result too large");
  const v = object(value); exact(v, ["protocolVersion", "jobId", "daemonEpoch", "fileRevisionId", "attemptId", "inputDigest", "identity", "vectors"]);
  for (const key of ["protocolVersion", "jobId", "daemonEpoch", "fileRevisionId", "attemptId", "inputDigest"] as const) if (v[key] !== request[key]) throw new Error("remote embedding: stale result");
  const identity = validatePreparedEmbeddingIdentity(v.identity);
  if (JSON.stringify(identity) !== JSON.stringify(validatePreparedEmbeddingIdentity(request.identity))) throw new Error("remote embedding: identity differs");
  if (!Array.isArray(v.vectors) || v.vectors.length !== request.chunks.length) throw new Error("remote embedding: partial result");
  const finite = (a: unknown, n: number): a is number[] => Array.isArray(a) && a.length === n && a.every(x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 3.4028234663852886e38);
  let decodedBytes = 0;
  v.vectors.forEach((raw, i) => {
    const r = object(raw); exact(r, ["id", "dense", "colbert", "scale", "pooled", "tokenIds"]);
    if (r.id !== request.chunks[i].id || !finite(r.dense, identity.generation.vectorDim) || !finite(r.pooled, identity.colbertDim) || typeof r.scale !== "number" || !Number.isFinite(r.scale) || r.scale <= 0 || !Array.isArray(r.tokenIds) || r.tokenIds.length < 1 || r.tokenIds.length > 512 || !r.tokenIds.every(x => Number.isSafeInteger(x) && x >= 0 && x <= 2147483647) || typeof r.colbert !== "string") throw new Error("remote embedding: invalid vector");
    const bytes = Buffer.from(r.colbert, "base64");
    decodedBytes += bytes.length + (r.dense as number[]).length*4 + (r.pooled as number[]).length*4 + r.tokenIds.length*4;
    if (decodedBytes > 8388608) throw new Error("remote embedding: decoded result too large");
    if (bytes.toString("base64") !== r.colbert || bytes.length !== r.tokenIds.length * identity.colbertDim || bytes.includes(128)) throw new Error("remote embedding: invalid packed representation");
  });
  return { ...v, identity } as unknown as RemoteEmbeddingResult;
}
