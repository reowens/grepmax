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
  const paired = process.argv[3] === '--paired';
  if (process.argv.length !== (paired ? 4 : 3)) throw new Error('Expected fixed experiment root');
  const root = fs.realpathSync(process.argv[2]);
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'onnx-artifact.json')));
  const modelPath = path.join(root, 'model-onnx/model_int8.onnx');
  if (sha(fs.readFileSync(modelPath)) !== expectedHash) throw new Error('ONNX artifact differs from deployed hash');
  const requireInstalled = createRequire(artifact.installedPackageJson);
  const installedVersion = JSON.parse(fs.readFileSync(artifact.installedPackageJson)).version;
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
    const measurements = [];
    async function measure(selected, batchSize, repetition, kind, warmup = false) {
      const started = performance.now(); const cpuStarted = process.cpuUsage(); const rows = [];
      const iterations = paired && !warmup ? 5 : 1;
      for (let iteration = 0; iteration < iterations; iteration++) {
        rows.length = 0;
        for (let start = 0; start < selected.length; start += batchSize) rows.push(...await forward(selected.slice(start, start + batchSize)));
      }
      const seconds = (performance.now() - started) / 1000;
      const cpu = process.cpuUsage(cpuStarted);
      if (warmup) return { ok: true, warmed: true };
      const joined = new Float32Array(rows.reduce((n, row) => n + row.length, 0));
      let offset = 0; for (const row of rows) { joined.set(row, offset); offset += row.length; }
      const bytes = Buffer.from(joined.buffer);
      const file = `onnx-${kind}-batch${batchSize}-pass${repetition}.f32`;
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
      const measurement = { device: 'onnx-cpu', kind, batchSize, repetition, iterations, seconds, secondsPerTraversal: seconds / iterations, cpuUserSeconds: cpu.user / 1e6,
        cpuSystemSeconds: cpu.system / 1e6, inputs: selected.length, ids: selected.map(i => i.id),
        effectiveTokens: selected.reduce((n, item) => n + item.inputIds.length, 0), file, sha256: sha(bytes),
        format: 'little-endian float32, input order, unpadded token rows, 48 columns' };
      measurements.push(measurement);
      return { ok: true, measurement };
    }
    if (paired) {
      process.stdout.write(JSON.stringify({ ok: true, ready: true }) + '\n');
      const lines = require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.length > 1024) throw new Error('Oversized paired command');
        const job = JSON.parse(line);
        if (job.command === 'close') break;
        if (!['query', 'document'].includes(job.kind) || ![1, 8, 16].includes(job.batchSize) || ![0, 1, 2].includes(job.repetition)) throw new Error('Invalid paired phase');
        const selected = inputs.filter(i => i.kind === job.kind);
        const result = await measure(selected, job.batchSize, job.repetition, job.kind, job.repetition === 0);
        process.stdout.write(JSON.stringify(result) + '\n');
      }
    } else {
      await forward(inputs.slice(0, 1));
      for (const batchSize of [1, 8, 16]) for (const repetition of [1, 2]) await measure(inputs, batchSize, repetition, 'all');
    }
    Object.assign(state, { ok: true, ortVersion: version, installedGmax: installedVersion,
      weightsSha256: expectedHash, inputsSha256: sha(inputBytes), options, loadSeconds, measurements });
  } finally { await session.release(); }
}
main().catch(error => { state.error = String(error.message).slice(0, 500); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync('onnx-result.json', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: state.ok, inferencePerformed: state.inferencePerformed, error: state.error }) + '\n');
});
