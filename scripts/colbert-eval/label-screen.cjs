#!/usr/bin/env node
'use strict';
// Explicit isolated ColBERT-only labeled screen. Never opens an index or service.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { execFileSync, spawn } = require('node:child_process');
const { stripTypeScriptTypes } = require('node:module');
const { inner } = require('numkong');
const REPO = path.resolve(__dirname, '../..');
const BUNDLE = path.join(REPO, 'docs/measurements/colbert-backend-wave1-20261023/bundle-v4');
const OLD = path.join(REPO, 'docs/measurements/embeddinggemma2-eval-20261021-mac-01');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const need = (value, message) => { if (!value) throw new Error(message); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function digest(file) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024), hash = crypto.createHash('sha256');
  try { for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
async function eachLine(file, consume) {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) { need(line.length <= 2 * 1024 * 1024, 'Excessive JSONL row'); await consume(JSON.parse(line)); }
}
function source(name) { return execFileSync('git', ['-C', REPO, 'show', `v0.26.96:${name}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 }); }
const strip = text => stripTypeScriptTypes(text, { mode: 'strip' });
const removeImports = text => text.replace(/^import\s[\s\S]*?from\s+["'][^"']+["'];/gm, '').replace(/\bexport\s+(?=class|function)/g, '');
async function child(root) {
  const inventory = json(path.join(BUNDLE, 'result-manifest.json'));
  const fixtureBytes = fs.readFileSync(path.join(BUNDLE, 'fixture.json'));
  need(sha(fixtureBytes) === 'b039ee9601f509abaaaf0f3c67b661476a4965a3df02612d1965792524b105c0', 'Frozen question set changed');
  const fixture = JSON.parse(fixtureBytes);
  need(fixture.cases.length === 30 && inventory.answers.length === 30, 'Expected 30 labels');
  const chunksPath = path.join(BUNDLE, 'chunks.jsonl'), featuresPath = path.join(OLD, 'colbert-features.jsonl');
  const featureManifest = json(path.join(OLD, 'colbert-features-manifest.json'));
  need(digest(chunksPath) === 'f2ddd29dbf7db85ae75c7dbbe35f915fdb8e834a29656f453a2646b8ec051009', 'Frozen chunks changed');
  need(digest(featuresPath) === 'cfa90dae0c54d038f528462e6e483063f400c1f38bb4fab2500552752ac124ab' && featureManifest.chunks === 12717, 'ONNX document cache changed');
  const skipBytes = fs.readFileSync(path.join(root, 'saved-skiplist.json'));
  for (const [file, expected] of [['skiplist.json', sha(skipBytes)], ['tokenizer.json', digest(path.join(root, 'model/tokenizer.json'))], ['onnx/model_int8.onnx', digest(path.join(root, 'model-onnx/model_int8.onnx'))]]) {
    need(featureManifest.model.files.find(f => f.path === file)?.sha256 === expected, 'Cached ONNX artifact/preprocessing mismatch');
  }
  const queryPath = path.join(BUNDLE, 'historical/ranking/pass-small-1.queries.jsonl');
  const queryInventory = inventory.inventory.find(i => i.path === 'historical/ranking/pass-small-1.queries.jsonl');
  need(queryInventory && digest(queryPath) === queryInventory.sha256, 'Frozen query cache changed');
  const queries = new Map(); await eachLine(queryPath, q => queries.set(q.id, q.features));
  for (const c of fixture.cases) need(queries.get(c.id)?.colbert?.length === 32 && queries.get(c.id).colbertDim === 48 && queries.get(c.id).colbert.every(row => row.length === 48 && row.every(Number.isFinite)), 'Query feature coverage/shape mismatch');
  const sourceNames = ['src/lib/workers/embeddings/colbert.ts', 'src/lib/workers/colbert-tokenizer.ts', 'src/lib/workers/colbert-math.ts', 'src/lib/workers/orchestrator.ts'];
  const sources = Object.fromEntries(sourceNames.map(n => [n, source(n)]));
  const { AutoTokenizer, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  const Tokenizer = new Function('AutoTokenizer', strip(removeImports(sources[sourceNames[1]])) + '\nreturn ColBERTTokenizer;')(AutoTokenizer);
  const tokenizer = new Tokenizer(); await tokenizer.init(path.join(root, 'model'));
  const answerChunks = new Map();
  for (const c of fixture.cases) {
    const answer = inventory.answers.find(a => a.caseId === c.id);
    need(answer && answer.coveringChunkMatches.length > 0, 'Missing answer content proof');
    for (const target of c.expected) need(digest(path.join(BUNDLE, 'sources', c.corpus, target.file)) === target.sourceSha256, 'Frozen labeled source changed');
    for (const match of answer.coveringChunkMatches) answerChunks.set(match.id, match);
  }
  console.error('Tokenizing all 12717 frozen documents; matching cached ONNX token IDs');
  const docs = new Map(); const fd = fs.openSync('document-inputs.jsonl', 'wx', 0o600);
  try {
    await eachLine(chunksPath, async chunk => {
      need(!docs.has(chunk.id) && sha(chunk.content) === chunk.contentSha256, 'Chunk identity/content mismatch');
      const match = answerChunks.get(chunk.id);
      if (match) need(sha(Buffer.from(chunk.content).subarray(match.offsetUtf8Bytes, match.offsetUtf8Bytes + match.bytes)) === match.sha256, 'Answer content proof failed');
      const encoded = await tokenizer.encodeDoc(chunk.content);
      const item = { id: chunk.id, inputIds: encoded.input_ids.map(Number), attentionMask: encoded.attention_mask.map(Number) };
      fs.writeSync(fd, JSON.stringify(item) + '\n');
      docs.set(chunk.id, { id: chunk.id, corpus: chunk.corpus, file: chunk.file, startLine: chunk.start_line, endLine: chunk.end_line, tokenIds: item.inputIds });
    });
  } finally { fs.closeSync(fd); }
  need(docs.size === 12717 && [...answerChunks.keys()].every(id => docs.has(id)), 'Incomplete frozen document coverage');
  const cached = new Map();
  await eachLine(featuresPath, f => {
    const doc = docs.get(f.id); need(doc && !cached.has(f.id) && f.tokenIds.join() === doc.tokenIds.join(), 'ONNX/MPS token inputs differ');
    const bytes = Buffer.from(f.colbert, 'base64');
    need(bytes.length === doc.tokenIds.length * 48 && Number.isFinite(f.scale) && f.scale > 0, 'Malformed cached document');
    cached.set(f.id, { colbert: new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), scale: f.scale, token_ids: f.tokenIds });
  });
  need(cached.size === docs.size, 'Incomplete ONNX document cache');
  fs.writeFileSync('input-proof.json', JSON.stringify({ fixtureSha256: sha(fixtureBytes), chunksSha256: digest(chunksPath), cachedDocumentsSha256: digest(featuresPath), queryCacheSha256: digest(queryPath), tokenInputSha256: digest('document-inputs.jsonl'), exactTokenIdsMatched: docs.size, verifiedAnswers: fixture.cases.length, skiplistSha256: sha(skipBytes) }, null, 2) + '\n');
  console.error('Exact token-ID matching passed; starting owned MPS document arm');
  await new Promise((resolve, reject) => {
    const p = spawn(path.join(root, 'venv/bin/python'), ['-I', '-B', path.join(__dirname, 'label-screen.py'), root], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
    p.once('error', reject); p.once('exit', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error('MPS document arm failed')));
  });
  const mps = json('mps-result.json');
  need(mps.documents === docs.size && mps.inputsSha256 === digest('document-inputs.jsonl') && mps.outputSha256 === digest('mps-documents.f32'), 'MPS output identity mismatch');
  const modelId = featureManifest.model.model;
  const config = { MODEL_IDS: { colbert: modelId }, PATHS: { models: '/offline-no-models' } };
  const deny = () => { throw new Error('Model loading forbidden in score replay'); };
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  const Model = new Function('ort', 'MODEL_IDS', 'PATHS', 'ColBERTTokenizer', 'fs', 'path', strip(removeImports(sources[sourceNames[0]]).replace('private readonly modelId', 'modelId')) + '\nreturn ColbertModel;')({ Tensor }, config.MODEL_IDS, config.PATHS, class { constructor() { deny(); } }, { existsSync: deny }, path);
  const maxSim = new Function('inner', 'MODEL_IDS', 'PATHS', 'fs', 'path', strip(removeImports(sources[sourceNames[2]])) + '\nreturn maxSim;')(inner, config.MODEL_IDS, config.PATHS,
    { existsSync: p => p.endsWith('/skiplist.json'), readFileSync: p => { need(p.endsWith('/skiplist.json'), 'Unexpected replay file read'); return skipBytes.toString(); } }, path);
  const orch = sources[sourceNames[3]];
  const coerce = orch.slice(orch.indexOf('export function coerceColbertBytes'), orch.indexOf('const CACHE_DIR')).replace('export ', '');
  const rerank = orch.slice(orch.indexOf('  async rerank(input:'), orch.lastIndexOf('\n}'));
  const Replay = new Function('maxSim', strip(coerce + '\nclass Replay {\n' + rerank + '\n}\n') + '\nreturn Replay;')(maxSim);
  const scorer = new Replay(); scorer.ensureReady = async () => {}; scorer.generation = { colbertModel: modelId };
  const rankings = new Map(fixture.cases.map(c => [c.id, { onnx: [], mps: [] }]));
  const rawFd = fs.openSync('mps-documents.f32', 'r'); let offset = 0, count = 0;
  console.error('Scoring every document within each question corpus with fixed ONNX queries');
  try {
    for (const doc of docs.values()) {
      const bytes = Buffer.alloc(doc.tokenIds.length * 48 * 4);
      need(fs.readSync(rawFd, bytes, 0, bytes.length, offset) === bytes.length, 'Truncated MPS document vectors'); offset += bytes.length;
      const data = new Float32Array(doc.tokenIds.length * 48); for (let i = 0; i < data.length; i++) data[i] = bytes.readFloatLE(i * 4);
      const model = Object.create(Model.prototype);
      model.tokenizer = { encodeDoc: async () => ({ input_ids: doc.tokenIds.map(BigInt), attention_mask: doc.tokenIds.map(() => 1n) }) };
      model.session = { outputNames: ['tokens'], run: async () => ({ tokens: { data, dims: [1, doc.tokenIds.length, 48] } }) };
      const stored = (await model.runBatch([doc.id], [new Float32Array(0)], 0))[0];
      const candidate = { colbert: stored.colbert, scale: stored.scale, token_ids: stored.token_ids };
      for (const c of fixture.cases.filter(c => c.corpus === doc.corpus)) {
        const scores = await scorer.rerank({ query: queries.get(c.id).colbert, docs: [cached.get(doc.id), candidate], colbertDim: 48 });
        need(scores.every(Number.isFinite), 'Nonfinite score');
        rankings.get(c.id).onnx.push({ id: doc.id, score: scores[0] });
        rankings.get(c.id).mps.push({ id: doc.id, score: scores[1] });
      }
      if (++count % 1024 === 0) console.error(`Scored ${count}/12717 documents`);
    }
    need(offset === fs.statSync('mps-documents.f32').size, 'Extra MPS vector bytes');
  } finally { fs.closeSync(rawFd); }
  const cases = [];
  for (const c of fixture.cases) {
    const answer = inventory.answers.find(a => a.caseId === c.id), targets = new Set(answer.coveringChunkIds);
    const record = { id: c.id, corpus: c.corpus, query: c.query, documentQuestion: c.expected.every(t => /\.(md|mdx|rst|txt)$/i.test(t.file)), expected: c.expected, expectedChunkIds: [...targets] };
    for (const backend of ['onnx', 'mps']) {
      const list = rankings.get(c.id)[backend].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      const rank = list.findIndex(row => targets.has(row.id)) + 1;
      record[backend] = { rank: rank || null, foundAt10: rank > 0 && rank <= 10, reciprocalRankAt10: rank > 0 && rank <= 10 ? 1 / rank : 0, candidates: list.length, top10: list.slice(0, 10).map(row => ({ ...row, file: docs.get(row.id).file, startLine: docs.get(row.id).startLine, endLine: docs.get(row.id).endLine })) };
    }
    cases.push(record);
  }
  const summarize = list => Object.fromEntries(['onnx', 'mps'].map(backend => [backend, { cases: list.length, foundAt10: list.filter(c => c[backend].foundAt10).length, recallAt10: list.length ? list.filter(c => c[backend].foundAt10).length / list.length : null, mrrAt10: list.length ? list.reduce((s, c) => s + c[backend].reciprocalRankAt10, 0) / list.length : null }]));
  const result = { ok: true, inferencePerformed: true, productionChanged: false, scope: 'ColBERT-only all-chunk ranking within each frozen corpus, fixed historical ONNX queries and ONNX document control; original-weight FP32 MPS candidate documents. No Granite/FTS/fusion/symbol/ANN pipeline or end-to-end claim.',
    sourceRef: 'v0.26.96', sourceCommit: execFileSync('git', ['-C', REPO, 'rev-parse', 'v0.26.96^{commit}'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(Object.entries(sources).map(([n,s]) => [n,sha(s)])), inputProof: json('input-proof.json'), mps,
    exposure: 'Previously reviewed exposed 30-question regression fixture, not a blind holdout', aggregate: summarize(cases), documents: summarize(cases.filter(c => c.documentQuestion)), code: summarize(cases.filter(c => !c.documentQuestion)),
    byCorpus: Object.fromEntries(fixture.corpora.map(c => [c.id, summarize(cases.filter(q => q.corpus === c.id))])),
    lostAt10: cases.filter(c => c.onnx.foundAt10 && !c.mps.foundAt10).map(c => c.id), gainedAt10: cases.filter(c => !c.onnx.foundAt10 && c.mps.foundAt10).map(c => c.id), cases };
  fs.writeFileSync('label-result.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ok: true, inferencePerformed: true, modelConstructed: true, resultPath: path.resolve('label-result.json'), aggregate: result.aggregate, lostAt10: result.lostAt10, gainedAt10: result.gainedAt10 };
}
async function main() {
  const [mode, rootArg] = process.argv.slice(2);
  need(['--execute', '--child'].includes(mode) && rootArg && process.argv.length === 4, 'Expected --execute /absolute/prepared-root');
  const root = fs.realpathSync(rootArg);
  if (mode === '--child') {
    const result = await child(root); process.stdout.write(JSON.stringify(result) + '\n'); return;
  }
  const { runMacSmoke } = require('./runner.cjs');
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await runMacSmoke(root, { execute: true, labelScreen: true, signal: controller.signal });
    console.log(JSON.stringify({ ok: result.ok, code: result.code, response: result.response, evaluationRoot: result.evaluationRoot, manifestPath: result.manifestPath }));
    if (!result.ok) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
