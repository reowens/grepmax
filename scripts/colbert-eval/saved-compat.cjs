#!/usr/bin/env node
'use strict';
// Offline replay only: no model runtime, tokenizer initialization, store or service.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { stripTypeScriptTypes } = require('node:module');
const { inner } = require('numkong');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const requireTrue = (value, message) => { if (!value) throw new Error(message); };
const ref = 'v0.26.96';
const sourceNames = ['src/lib/workers/embeddings/colbert.ts', 'src/lib/workers/orchestrator.ts', 'src/lib/workers/colbert-math.ts'];
const sources = Object.fromEntries(sourceNames.map(name => [name, execFileSync('git', ['show', `${ref}:${name}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 })]));
const sourceCommit = execFileSync('git', ['rev-parse', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
const js = text => stripTypeScriptTypes(text, { mode: 'strip' });
const removeImports = text => text.replace(/^import\s[\s\S]*?from\s+["'][^"']+["'];/gm, '').replace(/\bexport\s+(?=class|function)/g, '');

async function main() {
  requireTrue(process.argv.length === 3, 'Expected private experiment root');
  const root = fs.realpathSync(process.argv[2]);
  const work = path.join(root, 'run-03/work');
  const out = path.join(root, 'saved-compat');
  fs.mkdirSync(out); // Refuse overwriting prior evidence.
  const inputsBytes = fs.readFileSync(path.join(root, 'inputs.json'));
  const { inputs } = JSON.parse(inputsBytes);
  const reportBytes = fs.readFileSync(path.join(work, 'result.json'));
  const report = JSON.parse(reportBytes);
  requireTrue(report.inputsSha256 === sha(inputsBytes), 'Input identity mismatch');
  const skipBytes = fs.readFileSync(path.join(root, 'saved-skiplist.json'));
  const skipIds = JSON.parse(skipBytes);
  requireTrue(Array.isArray(skipIds) && skipIds.every(Number.isInteger), 'Invalid frozen skiplist');
  const modelId = 'ryandono/mxbai-edge-colbert-v0-17m-onnx-int8';
  const config = { MODEL_IDS: { colbert: modelId }, PATHS: { models: '/offline-no-models' } };
  const deny = () => { throw new Error('Runtime/model access forbidden during saved replay'); };
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  const ColbertModel = new Function('ort', 'MODEL_IDS', 'PATHS', 'ColBERTTokenizer', 'fs', 'path',
    js(removeImports(sources[sourceNames[0]]).replace('private readonly modelId', 'modelId')) + '\nreturn ColbertModel;')({ Tensor }, config.MODEL_IDS, config.PATHS, class { constructor() { deny(); } }, { existsSync: deny }, path);
  const { maxSim } = new Function('inner', 'MODEL_IDS', 'PATHS', 'fs', 'path',
    js(removeImports(sources[sourceNames[2]])) + '\nreturn {maxSim};')(inner, config.MODEL_IDS, config.PATHS,
      { existsSync: p => p.endsWith('/skiplist.json'), readFileSync: p => { requireTrue(p.endsWith('/skiplist.json'), 'Unexpected product file read'); return skipBytes.toString(); } }, path);
  const orchestrator = sources[sourceNames[1]];
  const coerce = orchestrator.slice(orchestrator.indexOf('export function coerceColbertBytes'), orchestrator.indexOf('const CACHE_DIR'));
  const rerank = orchestrator.slice(orchestrator.indexOf('  async rerank(input:'), orchestrator.lastIndexOf('\n}'));
  const Replay = new Function('maxSim', js(coerce.replace('export ', '') + '\nclass Replay {\n' + rerank + '\n}\n') + '\nreturn Replay;')(maxSim);
  const scorer = new Replay(); scorer.ensureReady = async () => {}; scorer.generation = { colbertModel: modelId };
  const queryBody = orchestrator.slice(orchestrator.indexOf('    const matrix: number[][] = [];'), orchestrator.indexOf('  async rerank(input:')).replace(/\n  }\s*$/, '');
  const queryFeatures = new Function(js('function queryFeatures(data: Float32Array, seq: number, dim: number) { const denseVector: number[] = [];\n' + queryBody + '\n}\n') + '\nreturn queryFeatures;')();

  function loadWire(file, selected, expectedHash) {
    const bytes = fs.readFileSync(file);
    if (expectedHash) requireTrue(sha(bytes) === expectedHash, 'Saved vector hash mismatch');
    requireTrue(bytes.length === selected.reduce((sum, i) => sum + i.inputIds.length * 48 * 4, 0), 'Saved vector length mismatch');
    const rows = new Map(); let offset = 0;
    for (const item of selected) {
      const data = new Float32Array(item.inputIds.length * 48);
      for (let n = 0; n < data.length; n++) { data[n] = bytes.readFloatLE(offset); offset += 4; }
      requireTrue(data.every(Number.isFinite), 'Nonfinite saved output'); rows.set(item.id, data);
    }
    return rows;
  }
  const queries = inputs.filter(i => i.kind === 'query'), docs = inputs.filter(i => i.kind === 'document');
  requireTrue(queries.length === 32 && docs.length === 32, 'Expected 32 queries and documents');
  const measurement = (device, kind, batchSize, repetition) => report.measurements.find(m => m.device === device && m.kind === kind && m.batchSize === batchSize && m.repetition === repetition);
  const q = measurement('onnx-cpu', 'query', 1, 1);
  const queryRaw = loadWire(path.join(work, q.file), queries, q.sha256);
  const queryMatrices = queries.map(i => queryFeatures(queryRaw.get(i.id), i.inputIds.length, 48).colbert);
  const configurations = [ ['onnx16-pass1', 'onnx-cpu', 16, 1], ['onnx16-pass2', 'onnx-cpu', 16, 2], ['onnx1-pass1', 'onnx-cpu', 1, 1], ['mps16-pass1', 'mps', 16, 1], ['mps16-pass2', 'mps', 16, 2] ];
  const results = [];
  for (const [name, device, batch, pass] of configurations) {
    console.error('Replaying ' + name);
    const m = measurement(device, 'document', batch, pass);
    const file = device === 'mps' ? path.join(out, name + '.f32') : path.join(work, m.file);
    if (device === 'mps') {
      // Existing isolated NumPy only; no torch/PyLate import or inference.
      execFileSync(path.join(root, 'venv/bin/python'), ['-I', '-B', '-c',
        'import numpy as np,sys,hashlib,json\np=sys.argv[1]\nassert hashlib.sha256(open(p,"rb").read()).hexdigest()==sys.argv[3]\nids=json.loads(sys.argv[4])\nwith np.load(p,allow_pickle=False) as a:\n assert set(a.files)==set(ids)\n data=np.concatenate([a[i].astype("<f4").reshape(-1) for i in ids])\n assert np.isfinite(data).all()\n data.tofile(sys.argv[2])',
        path.join(work, m.file), file, m.sha256, JSON.stringify(docs.map(i => i.id))], { timeout: 30000, maxBuffer: 4096 });
    }
    const raw = loadWire(file, docs, device === 'mps' ? null : m.sha256);
    const stored = [];
    for (const doc of docs) {
      const model = Object.create(ColbertModel.prototype);
      model.tokenizer = { encodeDoc: async () => ({ input_ids: doc.inputIds.map(BigInt), attention_mask: doc.attentionMask.map(BigInt) }) };
      model.session = { outputNames: ['tokens'], run: async () => ({ tokens: { data: raw.get(doc.id), dims: [1, doc.inputIds.length, 48] } }) };
      const value = (await model.runBatch([doc.id], [new Float32Array(0)], 0))[0];
      requireTrue(value.colbert.length === doc.inputIds.length * 48 && value.scale > 0 && Number.isFinite(value.scale), 'Invalid stored document');
      requireTrue(value.pooled_colbert_48d.every(Number.isFinite) && value.token_ids.join() === doc.inputIds.join(), 'Pool/token alignment failure');
      const bytes = Buffer.from(value.colbert.buffer);
      const restored = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      requireTrue(restored.every((v, idx) => v === value.colbert[idx]), 'Signed-byte round-trip failure');
      stored.push({ id: doc.id, colbert: value.colbert, scale: value.scale, pooled: value.pooled_colbert_48d, token_ids: value.token_ids });
    }
    const scores = [];
    for (const query of queryMatrices) scores.push(await scorer.rerank({ query, docs: stored, colbertDim: 48 }));
    requireTrue(scores.flat().every(Number.isFinite), 'Nonfinite score');
    results.push({ name, stored, scores, vectorSha256: sha(fs.readFileSync(file)) });
  }
  const baseline = results[0];
  const rank = scores => scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score || a.index - b.index).map(x => x.index);
  const metrics = [];
  for (const result of results.slice(1)) {
    const deltas = [], inversions = [], changedTop1 = [], top1Changes = [], top5 = [], pools = [], byteChanges = [];
    for (let d = 0; d < docs.length; d++) {
      const a = baseline.stored[d], b = result.stored[d];
      byteChanges.push(a.colbert.reduce((sum, value, index) => sum + (value !== b.colbert[index] ? 1 : 0), 0) / a.colbert.length);
      pools.push(inner(a.pooled, b.pooled));
    }
    for (let qi = 0; qi < queries.length; qi++) {
      const a = baseline.scores[qi], b = result.scores[qi], ra = rank(a), rb = rank(b);
      deltas.push(...a.map((v, i) => Math.abs(v - b[i])));
      if (ra[0] !== rb[0]) {
        changedTop1.push(queries[qi].id);
        top1Changes.push({ query: queries[qi].id, baselineDocument: docs[ra[0]].id, candidateDocument: docs[rb[0]].id, baselineGap: a[ra[0]] - a[rb[0]], candidateGap: b[rb[0]] - b[ra[0]], identicalTokenIds: docs[ra[0]].inputIds.join() === docs[rb[0]].inputIds.join() });
      }
      top5.push(ra.slice(0, 5).filter(i => rb.slice(0, 5).includes(i)).length / 5);
      for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) {
        if ((a[i] - a[j]) * (b[i] - b[j]) < 0) inversions.push({ query: queries[qi].id, documents: [docs[i].id, docs[j].id], baselineGap: Math.abs(a[i] - a[j]), candidateGap: Math.abs(b[i] - b[j]) });
      }
    }
    deltas.sort((a,b)=>a-b);
    metrics.push({ name: result.name, meanAbsoluteScoreDelta: deltas.reduce((a,b)=>a+b,0)/deltas.length, maxAbsoluteScoreDelta: deltas.at(-1), p95AbsoluteScoreDelta: deltas[Math.ceil(deltas.length*.95)-1],
      changedTop1Queries: changedTop1, top1Changes, meanTop5Overlap: top5.reduce((a,b)=>a+b,0)/top5.length, strictPairInversions: inversions.length,
      maxBaselineGapAmongInversions: inversions.length ? Math.max(...inversions.map(i=>i.baselineGap)) : 0, inversions,
      minPooledCosine: Math.min(...pools), meanChangedInt8FractionPerDocument: byteChanges.reduce((a,b)=>a+b,0)/byteChanges.length });
  }
  const output = { inferencePerformed: false, productionChanged: false, sourceRef: ref, sourceCommit,
    sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, text])=>[name,sha(text)])),
    inputsSha256: sha(inputsBytes), runResultSha256: sha(reportBytes), skiplistSha256: sha(skipBytes), skipIds,
    querySource: q.file, baseline: baseline.name, formatReplayPassed: true, queries: queries.length, documents: docs.length, scoresPerConfiguration: 1024,
    replayScriptSha256: sha(fs.readFileSync(__filename)), vectorHashes: Object.fromEntries(results.map(r=>[r.name,r.vectorSha256])),
    constructorNote: 'Model constructor is bypassed; its unused TS parameter-property modifier is removed for Node strip-only parsing. Actual runBatch, query normalization, byte coercion, rerank and maxSim arithmetic are retained.',
    metrics, scores: Object.fromEntries(results.map(r=>[r.name,r.scores])),
    limits: 'Synthetic 32-document pool, no relevance labels. Ranking agreement is not retrieval quality. Released normalization, int8 storage/pooled code and rerank/maxSim replayed with saved session outputs, fixed token IDs and frozen skiplist. No database write/read or ANN recall test. Duplicate/near-tied documents can change position. No exact-score tolerance was specified for this differing-precision comparison; broader labeled-retrieval and end-to-end promotion criteria are not checked here.' };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(output, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ formatReplayPassed: true, resultPath: path.join(out,'result.json'), metrics: metrics.map(({inversions,...m})=>m) }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
