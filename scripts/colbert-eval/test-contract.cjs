"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { LIMITS, ProtocolError, validateRequest, validateResponse, encodeLine,
  parseLine } = require("./contract.cjs");

const { request } = require("./test-helpers.cjs");

test("validation preserves exact ordered token IDs and copies caller-owned data", () => {
  const original = request();
  const result = validateRequest(original);
  assert.deepEqual(result, original);
  result.inputs[0].inputIds[0] = 9;
  assert.equal(original.inputs[0].inputIds[0], 50281);
});

test("inference is refused even with apparent permission or extra fields", () => {
  const r = request(); r.operation = "infer";
  assert.throws(() => validateRequest(r), { code: "inference_disabled" });
  r.operation = "validate"; r.allowInference = true;
  assert.throws(() => validateRequest(r), ProtocolError);
});

test("mutable model identities, altered dimensions and missing projection refuse", () => {
  for (const [key, value] of [["revision", "main"], ["dimensions", 128],
    ["projectionSha256", ""], ["documentStorage", "float32"],
    ["modelId", "LiquidAI/LFM2.5-ColBERT-350M"]]) {
    const r = request(); r.contract[key] = value;
    assert.throws(() => validateRequest(r), ProtocolError);
  }
});

test("token/mask lengths, token values and duplicate IDs refuse", () => {
  const changes = [
    (r) => { r.inputs[0].inputIds.push(-1); r.inputs[0].attentionMask.push(1); },
    (r) => { r.inputs[0].attentionMask[0] = 2; },
    (r) => { r.inputs[0].inputIds[0] = 2 ** 31; },
    (r) => { r.inputs[0].attentionMask.pop(); },
    (r) => { delete r.inputs[0].inputIds[0]; },
    (r) => { delete r.inputs[0].attentionMask[0]; },
    (r) => { r.inputs[1].id = r.inputs[0].id; },
    (r) => { r.inputs[0].inputIds = Array(33).fill(1);
      r.inputs[0].attentionMask = Array(33).fill(1); },
  ];
  for (const change of changes) {
    const r = request(); change(r);
    assert.throws(() => validateRequest(r), ProtocolError);
  }
});

test("32-query and 512-document boundaries are accepted without truncation", () => {
  const r = request();
  for (const i of r.inputs) {
    const length = i.kind === "query" ? 32 : 512;
    i.inputIds = Array(length).fill(42); i.attentionMask = Array(length).fill(1);
  }
  assert.deepEqual(validateRequest(r), r);
});

test("wire frames reject multi-line, invalid UTF-8, oversized or nonobject data", () => {
  assert.deepEqual(parseLine(encodeLine(request())), request());
  for (const frame of ["{}\n{}\n", Buffer.from([0xff]), "null\n", "[]\n",
    " ".repeat(LIMITS.frameBytes + 1)]) {
    assert.throws(() => parseLine(frame), ProtocolError);
  }
  assert.throws(() => encodeLine({ x: "x".repeat(LIMITS.frameBytes) }), ProtocolError);
});

test("responses cannot reorder inputs, attach vectors or claim inference", () => {
  const r = request();
  const good = { schemaVersion: 1, requestId: r.requestId, ok: true,
    operation: "validate", inferencePerformed: false, ids: ["query", "doc"],
    dimensions: 48 };
  assert.deepEqual(validateResponse(good, r), good);
  for (const extra of [{ ids: ["doc", "query"] }, { vectors: [] },
    { inferencePerformed: true }, { requestId: "other" }, { dimensions: 128 }]) {
    assert.throws(() => validateResponse({ ...good, ...extra }, r), ProtocolError);
  }
  const error = { schemaVersion: 1, requestId: r.requestId, ok: false,
    inferencePerformed: false, error: { code: "runtime_unavailable",
      message: "Inference is disabled" } };
  assert.deepEqual(validateResponse(error, r), error);
});
