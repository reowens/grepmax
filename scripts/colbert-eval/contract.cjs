"use strict";

const { TextDecoder } = require("node:util");

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const LIMITS = Object.freeze({
  schemaVersion: 1,
  frameBytes: 4 * MiB,
  maxInputs: 64,
  idChars: 80,
  queryMaxTokens: 32,
  documentMaxTokens: 512,
  dimensions: 48,
});
const DEFAULT_LIMITS = Object.freeze({
  ownedRssBytes: 6 * GiB,
  maxSwapGrowthBytes: 512 * MiB,
  maxDiskBytes: 12 * GiB,
  minAvailableMemoryBytes: 8 * GiB,
  minFreeDiskBytes: 15 * GiB,
  sampleIntervalMs: 1000,
  deadlineMs: 30 * 60 * 1000,
  maxStdoutBytes: LIMITS.frameBytes,
  maxStderrBytes: MiB,
});

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function requireValue(ok, code, message) {
  if (!ok) throw new ProtocolError(code, message);
}

function object(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

function keys(value, expected, code) {
  requireValue(object(value), code, "Expected a plain object");
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  requireValue(actual.length === expected.length &&
    actual.every((key, i) => key === sorted[i]),
  code, "Missing or unexpected fields");
}

function validId(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9._-]{1,80}$/.test(value);
}

function encodeLine(value) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { throw new ProtocolError("invalid_json", "Value is not serializable JSON"); }
  requireValue(typeof serialized === "string", "invalid_json", "Expected JSON value");
  requireValue(Buffer.byteLength(serialized, "utf8") + 1 <= LIMITS.frameBytes,
    "frame_too_large", "Protocol frame exceeds the limit");
  return `${serialized}\n`;
}

function parseLine(value) {
  requireValue(typeof value === "string" || Buffer.isBuffer(value),
    "invalid_frame", "Expected a UTF-8 line");
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  requireValue(bytes.length > 0 && bytes.length <= LIMITS.frameBytes,
    "frame_too_large", "Protocol frame is empty or exceeds the limit");
  let line;
  try { line = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ProtocolError("invalid_utf8", "Protocol frame is not UTF-8"); }
  if (line.endsWith("\n")) line = line.slice(0, -1);
  if (line.endsWith("\r")) line = line.slice(0, -1);
  requireValue(!line.includes("\n") && !line.includes("\r"),
    "invalid_frame", "Expected exactly one JSON line");
  let result;
  try { result = JSON.parse(line); }
  catch { throw new ProtocolError("invalid_json", "Protocol frame is not valid JSON"); }
  requireValue(object(result), "invalid_frame", "Protocol frame must be an object");
  return result;
}

function validateRequest(request) {
  keys(request, ["schemaVersion", "requestId", "operation", "contract", "inputs"],
    "invalid_request");
  requireValue(request.schemaVersion === LIMITS.schemaVersion,
    "unsupported_schema", "Unsupported protocol schema");
  requireValue(validId(request.requestId), "invalid_request_id", "Invalid request ID");
  requireValue(request.operation === "validate", "inference_disabled",
    "Wave 1 permits validation only; model inference is disabled");
  const c = request.contract;
  keys(c, ["modelId", "revision", "weightsSha256", "tokenizerSha256",
    "projectionSha256", "backend", "precision", "dimensions", "queryMaxTokens",
    "documentMaxTokens", "preparation", "normalization", "documentStorage"],
  "invalid_contract");
  requireValue(c.modelId === "mixedbread-ai/mxbai-edge-colbert-v0-17m",
    "unsupported_model", "Wave 1 prepares the current 17M model only");
  requireValue(typeof c.revision === "string" && /^[a-f0-9]{40}$/.test(c.revision),
    "invalid_revision", "An immutable model revision is required");
  requireValue([c.weightsSha256, c.tokenizerSha256, c.projectionSha256]
    .every((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)),
  "invalid_artifact_hash", "Exact artifact hashes are required");
  requireValue(["torch-cpu", "torch-mps"].includes(c.backend) &&
    ["float32", "float16"].includes(c.precision),
  "unsupported_backend", "Unsupported backend or precision");
  requireValue(c.dimensions === LIMITS.dimensions &&
    c.queryMaxTokens === LIMITS.queryMaxTokens &&
    c.documentMaxTokens === LIMITS.documentMaxTokens &&
    c.preparation === "gmax-token-ids-v1" &&
    c.normalization === "per-token-l2" &&
    c.documentStorage === "int8-per-document-maxabs-127",
  "incompatible_contract", "Token/vector/storage contract mismatch");
  requireValue(Array.isArray(request.inputs) && request.inputs.length > 0 &&
    request.inputs.length <= LIMITS.maxInputs,
  "invalid_inputs", "Expected 1 to 64 ordered inputs");
  const seen = new Set();
  for (const input of request.inputs) {
    keys(input, ["id", "kind", "inputIds", "attentionMask"], "invalid_input");
    requireValue(validId(input.id) && !seen.has(input.id), "invalid_input_id",
      "Input IDs must be valid and unique");
    seen.add(input.id);
    requireValue(["query", "document"].includes(input.kind), "invalid_input_kind",
      "Unsupported input kind");
    const max = input.kind === "query" ? c.queryMaxTokens : c.documentMaxTokens;
    requireValue(Array.isArray(input.inputIds) && input.inputIds.length > 0 &&
      input.inputIds.length <= max && Array.from(input.inputIds).every((v) =>
        Number.isInteger(v) && v >= 0 && v <= 2 ** 31 - 1),
    "invalid_tokens", "Token IDs or token count are invalid");
    requireValue(Array.isArray(input.attentionMask) &&
      input.attentionMask.length === input.inputIds.length &&
      Array.from(input.attentionMask).every((v) => v === 0 || v === 1),
    "invalid_mask", "Attention mask does not match the token sequence");
  }
  encodeLine(request);
  return JSON.parse(JSON.stringify(request));
}

function validateResponse(response, request) {
  const validated = validateRequest(request);
  requireValue(object(response) && response.schemaVersion === LIMITS.schemaVersion &&
    response.requestId === validated.requestId && response.inferencePerformed === false,
  "invalid_response", "Response schema, identity or inference state mismatch");
  if (response.ok === false) {
    keys(response, ["schemaVersion", "requestId", "ok", "error", "inferencePerformed"],
      "invalid_response");
    keys(response.error, ["code", "message"], "invalid_response");
    requireValue(typeof response.error.code === "string" &&
      /^[a-z0-9_]{1,80}$/.test(response.error.code) &&
      typeof response.error.message === "string" &&
      response.error.message.length > 0 && response.error.message.length <= 500,
    "invalid_response", "Invalid protocol error");
    return JSON.parse(JSON.stringify(response));
  }
  keys(response, ["schemaVersion", "requestId", "ok", "operation", "inferencePerformed",
    "ids", "dimensions"], "invalid_response");
  requireValue(response.ok === true && response.operation === "validate" &&
    response.dimensions === validated.contract.dimensions &&
    Array.isArray(response.ids) &&
    JSON.stringify(response.ids) === JSON.stringify(validated.inputs.map((i) => i.id)),
  "invalid_response", "Response shape or input order mismatch");
  encodeLine(response);
  return JSON.parse(JSON.stringify(response));
}

module.exports = { ProtocolError, LIMITS, DEFAULT_LIMITS, validateRequest,
  validateResponse, encodeLine, parseLine };
