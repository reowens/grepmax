#!/usr/bin/env node
'use strict';
// Invoked only inside the bounded Mac experiment's owned process group.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expectedHash = 'bf220582767b501f17fc8a9b484f92f43c7756908ea87f7ac5053682be495ded';
const state = { ok: false, inferencePerformed: false, modelConstructed: false };

async function main() {
  if (process.argv.length !== 3) throw new Error('Expected fixed experiment root');
  const root = fs.realpathSync(process.argv[2]);
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'onnx-artifact.json')));
  const modelPath = path.join(root, 'model-onnx/model_int8.onnx');
  if (sha(fs.readFileSync(modelPath)) !== expectedHash) throw new Error('ONNX artifact differs from deployed hash');
  const requireInstalled = createRequire(artifact.installedPackageJson);
  const version = requireInstalled('onnxruntime-node/package.json').version;
  if (version !== artifact.ortVersion || version !== '1.30.0') throw new Error('Installed ONNX runtime identity changed');
  const ort = requireInstalled('onnxruntime-node');
  const inputBytes = fs.readFileSync(path.join(root, 'inputs.json'));
  const { inputs } = JSON.parse(inputBytes);
  if (inputs.length !== 64) throw new Error('Expected 64 frozen inputs');
  const options = { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
    graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
  const loadStarted = performance.now();
  const session = await ort.InferenceSession.create(modelPath, options);
  state.modelConstructed = true;
  const loadSeconds = (performance.now() - loadStarted) / 1000;
  async function forward(batch) {
    const width = Math.max(...batch.map(item => item.inputIds.length));
    const ids = new BigInt64Array(batch.length * width).fill(50283n);
    const masks = new BigInt64Array(batch.length * width);
    for (let b = 0; b < batch.length; b++) for (let i = 0; i < batch[b].inputIds.length; i++) {
      ids[b * width + i] = BigInt(batch[b].inputIds[i]); masks[b * width + i] = BigInt(batch[b].attentionMask[i]);
    }
    state.inferencePerformed = true;
    const result = await session.run({ input_ids: new ort.Tensor('int64', ids, [batch.length, width]),
      attention_mask: new ort.Tensor('int64', masks, [batch.length, width]) });
    const output = result[session.outputNames[0]];
    if (!output || output.type !== 'float32' || output.dims.join(',') !== [batch.length, width, 48].join(',')) throw new Error('Unexpected ONNX token output');
    if (!output.data.every(Number.isFinite)) throw new Error('Nonfinite ONNX token output');
    const rows = batch.map((item, b) => output.data.slice(b * width * 48, b * width * 48 + item.inputIds.length * 48));
    for (const value of Object.values(result)) value.dispose?.();
    return rows;
  }
  try {
    await forward(inputs.slice(0, 1));
    const measurements = [];
    for (const batchSize of [1, 8, 16]) for (const repetition of [1, 2]) {
      const started = performance.now(); const cpuStarted = process.cpuUsage(); const rows = [];
      for (let start = 0; start < inputs.length; start += batchSize) rows.push(...await forward(inputs.slice(start, start + batchSize)));
      const seconds = (performance.now() - started) / 1000;
      const cpu = process.cpuUsage(cpuStarted);
      const joined = new Float32Array(rows.reduce((n, row) => n + row.length, 0));
      let offset = 0; for (const row of rows) { joined.set(row, offset); offset += row.length; }
      const bytes = Buffer.from(joined.buffer);
      const file = `onnx-batch${batchSize}-pass${repetition}.f32`;
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
      measurements.push({ device: 'onnx-cpu', batchSize, repetition, seconds, cpuUserSeconds: cpu.user / 1e6,
        cpuSystemSeconds: cpu.system / 1e6, inputs: inputs.length,
        effectiveTokens: inputs.reduce((n, item) => n + item.inputIds.length, 0), file, sha256: sha(bytes),
        format: 'little-endian float32, input order, unpadded token rows, 48 columns' });
    }
    Object.assign(state, { ok: true, ortVersion: version, installedGmax: artifact.installedVersion,
      weightsSha256: expectedHash, inputsSha256: sha(inputBytes), options, loadSeconds, measurements });
  } finally { await session.release(); }
}
main().catch(error => { state.error = String(error.message).slice(0, 500); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync('onnx-result.json', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: state.ok, inferencePerformed: state.inferencePerformed, error: state.error }) + '\n');
});
