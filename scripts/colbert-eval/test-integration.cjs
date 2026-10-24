"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { request } = require("./test-helpers.cjs");
const { validateRequest, validateResponse, encodeLine, parseLine } = require("./contract.cjs");

function adapter(input) {
  const guard = [
    "import builtins, runpy, sys",
    "original_import = builtins.__import__",
    "def guarded_import(name, *args, **kwargs):",
    "    if name.split('.')[0] in {'torch', 'pylate', 'numpy', 'transformers'}:",
    "        raise RuntimeError('Wave 1 validation imported an inference dependency')",
    "    return original_import(name, *args, **kwargs)",
    "builtins.__import__ = guarded_import",
    "sys.argv = [sys.argv[1]]",
    "runpy.run_path(sys.argv[0], run_name='__main__')",
  ].join("\n");
  const child = spawnSync("python3", ["-c", guard, path.join(__dirname, "adapter.py")], {
    input, encoding: "utf8", timeout: 8000, maxBuffer: 4 * 1024 ** 2,
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1",
      HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, "", "Protocol errors must not print source/stack diagnostics");
  const lines = child.stdout.trim().split("\n").filter(Boolean);
  return { ...child, responses: lines.map(parseLine) };
}

test("Python adapter accepts the JS validation protocol and preserves order", () => {
  const first = request();
  const second = request(); second.requestId = "cpu-02";
  second.contract.backend = "torch-cpu";
  second.inputs.reverse();
  const child = adapter(encodeLine(first) + encodeLine(second));
  assert.equal(child.status, 0);
  assert.equal(child.responses.length, 2);
  validateResponse(child.responses[0], first);
  validateResponse(child.responses[1], second);
});

test("Python and JS both reject malformed tokens, masks and inference bypasses", () => {
  const mutations = [
    (r) => { r.operation = "infer"; },
    (r) => { r.allowInference = true; },
    (r) => { r.contract.dimensions = 128; },
    (r) => { r.contract.revision = "main"; },
    (r) => { r.inputs[0].inputIds[0] = true; },
    (r) => { r.inputs[0].inputIds[0] = -1; },
    (r) => { r.inputs[0].inputIds[0] = 2 ** 31; },
    (r) => { r.inputs[0].attentionMask[0] = true; },
    (r) => { r.inputs[0].attentionMask.pop(); },
    (r) => { r.inputs[0].inputIds.push(null); r.inputs[0].attentionMask.push(1); },
    (r) => { r.inputs[1].id = r.inputs[0].id; },
    (r) => { r.inputs = []; },
    (r) => { r.contract.queryMaxTokens = 48; },
    (r) => { r.contract.modelPath = "/production/weights"; },
  ];
  for (const mutate of mutations) {
    const r = request(); mutate(r);
    assert.throws(() => validateRequest(r));
    const child = adapter(encodeLine(r));
    assert.equal(child.responses.length, 1);
    const response = child.responses[0];
    assert.equal(response.ok, false);
    assert.equal(response.inferencePerformed, false);
    assert.equal(typeof response.error.code, "string");
    assert.equal(Object.hasOwn(response, "vectors"), false);
  }
});

test("Python validates 32/512 boundaries without loading an inference runtime", () => {
  const r = request();
  for (const input of r.inputs) {
    const n = input.kind === "query" ? 32 : 512;
    input.inputIds = Array(n).fill(42); input.attentionMask = Array(n).fill(1);
  }
  const child = adapter(encodeLine(r));
  assert.equal(child.responses.length, 1);
  validateResponse(child.responses[0], r);
});
