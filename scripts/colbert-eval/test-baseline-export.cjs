'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const b = require('./baseline-export.cjs');
const H = '1'.repeat(64), REV = '2'.repeat(40), FILE = path.join(__dirname, 'baseline-export.cjs');
const array48 = n => Array(48).fill(n);
function fixture() {
  const chunks = ['doc-b', 'doc-a', 'doc-c'].map((id, i) => ({ id, path: `/frozen/${id}.ts`, content: `function value${i}() { return ${i}; }`, chunk_index: i, start_line: 0, end_line: 0 }));
  const model = dimensions => ({ modelId: 'synthetic/not-a-model', revision: REV, dimensions, precision: 'synthetic-f64', normalization: 'synthetic-none', artifacts: [{ path: 'mock.bin', sha256: H, bytes: 1 }] });
  return { chunks, plan: { schemaVersion: 1, baseline: { ...b.PIN },
    identities: Object.fromEntries(['sourceManifestSha256', 'chunkManifestSha256', 'sourceTreeSha256', 'scorerSha256', 'evaluatorAdapterSha256'].map(k => [k, H])),
    granite: model(3), colbert: model(48),
    documents: chunks.map(chunk => ({ id: chunk.id, sourceId: chunk.path, sourceSha256: H, chunkWireSha256: b.wireHash(b.snapshotWire(chunk)) })),
    questions: Array.from({ length: 30 }, (_, i) => ({ id: `q-${i}`, query: `frozen question ${i}` })) } };
}
const gate = (invoked = false) => ({ requestedRerank: invoked, threshold: 0.7, evaluated: !invoked, share: invoked ? null : 0.3, activated: false, rerankInvoked: invoked });
function response(invoked = false, empty = false) {
  return { data: [], diagnostics: { gate: gate(invoked), fts: { available: true, searchFailed: false }, stages: { pooled: empty ? 0 : 3 } } };
}
function encoding() { return { dense: new Float32Array([1, -0, 3]), colbert: [array48(0.25)], colbertDim: 48, pooled_colbert_48d: array48(0.1) }; }
async function material({ invoke = false, observe = true, unavailable = false } = {}) {
  const f = fixture(), capture = b.createCapture(f.plan, { provenance: 'synthetic' });
  f.chunks.forEach((chunk, i) => capture.recordDocument(chunk, new Float32Array([i, i + 1, i + 2])));
  for (const q of f.plan.questions) {
    const observer = capture.beginQuestion(q.id);
    const rawEncoding = encoding(), rawResult = new Float32Array([3, 2]);
    const pool = { encodeQuery: async () => rawEncoding, rerank: async () => rawResult };
    const wrapped = observer.wrapWorkerPool(pool);
    assert.equal(await wrapped.encodeQuery(q.query), rawEncoding);
    if (!unavailable) {
      const rows = [f.chunks[2], f.chunks[0]];
      const builder = { select() { return this; }, limit() { return this; }, where() { return this; }, async toArray() { return rows; } };
      const db = observer.wrapDatabase({ async ensureTable() { return { search(text) { assert.equal(text, q.query); return builder; } }; } });
      const table = await db.ensureTable();
      assert.equal(await table.search(q.query).select(['id']).limit(2).where('synthetic').toArray(), rows);
    }
    if (observe) observer.observeRanking({ structureWeights: [{ id: 'doc-b', value: 1.2 }], priors: [{ id: 'doc-a', value: 0 }], symbolAdditions: invoke ? ['doc-a'] : [] });
    if (invoke) {
      if (observe) observer.observeRerankIds(['doc-b', 'doc-a']);
      const input = { query: rawEncoding.colbert, docs: [
        { colbert: Buffer.from(array48(255)), scale: 0.5, token_ids: [1] },
        { colbert: new Int8Array(array48(-5)), scale: 0.25, token_ids: undefined },
      ], colbertDim: 48 };
      assert.equal(await wrapped.rerank(input), rawResult);
    }
    const r = response(invoke); if (unavailable) r.diagnostics.fts.available = false;
    observer.finish(r);
  }
  return { ...f, records: capture.records() };
}
function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmax-baseline-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return fs.realpathSync(dir); }
function files(t, value) {
  const dir = directory(t), planPath = path.join(dir, 'plan.json'), materialPath = path.join(dir, 'material.jsonl'), out = path.join(dir, 'out');
  fs.writeFileSync(planPath, JSON.stringify(value.plan));
  fs.writeFileSync(materialPath, value.records.map(b.canonical).join('\n') + '\n');
  return { dir, planPath, materialPath, out };
}
const clone = x => JSON.parse(JSON.stringify(x));
async function rejectsMaterial(t, mutate, code) {
  const value = await material({ invoke: true }); value.records = clone(value.records); mutate(value);
  const opts = files(t, value);
  assert.throws(() => b.processMaterial(opts), e => !code || e.code === code);
  assert.equal(fs.existsSync(opts.out), false);
  assert.equal(fs.readdirSync(opts.dir).some(f => f.startsWith('.baseline-export-')), false);
}

test('pack keeps exact ordering, vectors, lexical lists, calls and wire hashes; remains unqualified', async t => {
  const value = await material({ invoke: true }), opts = files(t, value), manifest = b.processMaterial(opts);
  assert.deepEqual(manifest.counts, { documents: 3, questions: 30, rerankInvoked: 30, rerankSkipped: 0 });
  assert.equal(manifest.currentRelease, false); assert.equal(manifest.qualification, 'unqualified'); assert.equal(manifest.status, 'incomplete');
  assert.equal(manifest.completeness.requiredObservationsComplete, false);
  assert(manifest.blockers.includes('q-0:ranking-coverage-unverified'));
  assert(manifest.blockers.includes('synthetic-observations-not-runtime-evidence'));
  assert.equal(fs.readFileSync(path.join(opts.out, 'material.jsonl'), 'utf8'), fs.readFileSync(opts.materialPath, 'utf8'));
  const rows = fs.readFileSync(path.join(opts.out, 'material.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.slice(1, 4).map(r => r.id), ['doc-b', 'doc-a', 'doc-c']);
  const q = rows[4]; assert.deepEqual(q.rerank.calls[0].candidateIds, ['doc-b', 'doc-a']);
  assert.deepEqual(b.decodeWire(q.lexical.calls[0].rows).map(r => r.id), ['doc-c', 'doc-b']);
  assert.deepEqual([...b.decodeWire(q.rerank.calls[0].result)], [3, 2]);
  assert.equal(b.decodeWire(q.rerank.calls[0].input).docs[0].colbert[0], 255);
  assert.equal(b.decodeWire(q.rerank.calls[0].input).docs[1].colbert[0], -5);
  assert.equal(Object.is(b.decodeWire(q.encoding).dense[1], -0), true);
  const wires = fs.readFileSync(path.join(opts.out, 'wire-hashes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(wires[4].parts.rerank[0].input, b.wireHash(q.rerank.calls[0].input));
  assert.equal(manifest.materialSha256, b.sha256(fs.readFileSync(opts.materialPath)));
  assert.equal(manifest.wireHashesSha256, b.sha256(fs.readFileSync(path.join(opts.out, 'wire-hashes.jsonl'))));
  assert.equal(fs.statSync(opts.out).mode & 0o777, 0o700);
  for (const f of fs.readdirSync(opts.out)) assert.equal(fs.statSync(path.join(opts.out, f)).mode & 0o777, 0o600);
});
test('legitimate no-rerank keeps empty call list, explicit gate reason and retrieval miss', async t => {
  const value = await material(), opts = files(t, value), result = b.processMaterial(opts);
  assert.equal(result.counts.rerankSkipped, 30);
  const q = value.records[4]; assert.equal(q.rerank.reason, 'released-gate-disabled'); assert.deepEqual(q.rerank.calls, []);
  assert.deepEqual(b.decodeWire(q.response).data, []);
  assert.equal(own(q.rerank, 'candidateIds'), false);
});
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
test('unobservable ranking/IDs remain named blockers, never guessed from diagnostic ranks', async t => {
  const value = await material({ invoke: true, observe: false }), result = b.processMaterial(files(t, value));
  assert.equal(result.completeness.requiredObservationsComplete, false);
  assert(result.blockers.includes('q-0:exact-rerank-chunk-ids-unobserved'));
  assert(result.blockers.includes('q-0:structure-weights-priors-symbol-additions-unobserved'));
  assert.equal(value.records[4].rerank.calls[0].candidateIds, null);
});
test('actual FTS unavailable is retained as absence rather than invented candidates', async t => {
  const value = await material({ unavailable: true }); const result = b.processMaterial(files(t, value));
  assert.equal(result.counts.questions, 30);
  assert.equal(value.records[4].lexical.state, 'unavailable'); assert.deepEqual(value.records[4].lexical.calls, []);
});
test('snapshots survive original input/result/buffer mutation and retain method this', async () => {
  const f = fixture(), capture = b.createCapture(f.plan, { provenance: 'synthetic' });
  const dense = new Float64Array([1, 2, 3]); capture.recordDocument(f.chunks[0], dense); dense[0] = 99;
  f.chunks.slice(1).forEach(c => capture.recordDocument(c, [1, 2, 3]));
  const obs = capture.beginQuestion('q-0'), rawEncoding = encoding(), result = [9], docs = Buffer.from(array48(7));
  const input = { query: rawEncoding.colbert, docs: [{ colbert: docs, scale: 1 }], colbertDim: 48 };
  const rawPool = { encodeQuery() { assert.equal(this, rawPool); return rawEncoding; }, rerank(arg) { assert.equal(this, rawPool); assert.equal(arg, input); docs[0] = 88; return result; } };
  const pool = obs.wrapWorkerPool(rawPool); assert.equal(await pool.encodeQuery('frozen question 0'), rawEncoding);
  assert.equal(await pool.rerank(input), result); result[0] = 123; docs[1] = 99; rawEncoding.dense[0] = 123; rawEncoding.colbert[0][0] = 123;
  const row = obs.finish(response(true));
  assert.equal(b.decodeWire(row.encoding).dense[0], 1); assert.equal(b.decodeWire(row.rerank.calls[0].input).docs[0].colbert[0], 7);
  assert.equal(b.decodeWire(row.rerank.calls[0].input).docs[0].colbert[1], 7); assert.equal(b.decodeWire(row.rerank.calls[0].result)[0], 9);
  assert(Object.isFrozen(row.rerank.calls[0].input.docs));
  assert.throws(() => capture.records(), { code: 'COVERAGE' });
});
test('lexical wrapper snapshots rows before released Searcher can clear/mutate them', async () => {
  const f = fixture(), cap = b.createCapture(f.plan); f.chunks.forEach(c => cap.recordDocument(c, [1, 2, 3]));
  const obs = cap.beginQuestion('q-0'), pool = obs.wrapWorkerPool({ encodeQuery: () => encoding() }); await pool.encodeQuery(f.plan.questions[0].query);
  const rows = [clone(f.chunks[1])], builder = { select() { return this; }, toArray() { assert.equal(this, builder); return rows; } };
  const db = obs.wrapDatabase({ async ensureTable() { return { search: () => builder }; } });
  assert.equal(await (await db.ensureTable()).search(f.plan.questions[0].query).select().toArray(), rows);
  rows[0].content = 'changed'; rows.length = 0;
  const q = obs.finish(response()); assert.equal(b.decodeWire(q.lexical.calls[0].rows)[0].content, f.chunks[1].content);
});
test('empty candidate rerank skip is directly justified by gate plus empty pooled stage', async () => {
  const f = fixture(), cap = b.createCapture(f.plan); f.chunks.forEach(c => cap.recordDocument(c, [1, 2, 3]));
  const obs = cap.beginQuestion('q-0'); await obs.wrapWorkerPool({ encodeQuery: () => encoding() }).encodeQuery(f.plan.questions[0].query);
  const r = response(true, true); r.diagnostics.gate.rerankInvoked = false;
  assert.equal(obs.finish(r).rerank.reason, 'empty-candidate-pool');
});
test('lexical snapshot failure stays fatal when released FTS catch converts it to unavailable', async () => {
  const f = fixture(), cap = b.createCapture(f.plan); f.chunks.forEach(c => cap.recordDocument(c, [1, 2, 3]));
  const obs = cap.beginQuestion('q-0'); await obs.wrapWorkerPool({ encodeQuery: () => encoding() }).encodeQuery(f.plan.questions[0].query);
  let successes = 0, caught;
  const rows = [Object.assign(Object.create({ custom: true }), f.chunks[0])];
  const builder = { async toArray() { successes++; return rows; } };
  const db = obs.wrapDatabase({ async ensureTable() { return { search: () => builder }; } });
  const r = response();
  try { await (await db.ensureTable()).search(f.plan.questions[0].query).toArray(); }
  catch (error) { caught = error; r.diagnostics.fts = { available: false, searchFailed: true }; }
  assert.equal(successes, 1, 'underlying FTS dependency succeeded');
  assert.equal(caught.code, 'WIRE');
  assert.throws(() => obs.finish(r), error => error === caught);
  assert.throws(() => cap.records(), error => error === caught);
  assert.throws(() => cap.beginQuestion('q-1'), error => error === caught);
  assert.equal(rows[0].id, f.chunks[0].id, 'original result is not substituted or mutated');
});
test('genuine underlying FTS failure remains ordinary released unavailability', async () => {
  const f = fixture(), cap = b.createCapture(f.plan); f.chunks.forEach(c => cap.recordDocument(c, [1, 2, 3]));
  const obs = cap.beginQuestion('q-0'); await obs.wrapWorkerPool({ encodeQuery: () => encoding() }).encodeQuery(f.plan.questions[0].query);
  const failure = new Error('synthetic dependency failure');
  const db = obs.wrapDatabase({ async ensureTable() { return { search: () => ({ async toArray() { throw failure; } }) }; } });
  const r = response();
  try { await (await db.ensureTable()).search(f.plan.questions[0].query).toArray(); }
  catch (error) { assert.equal(error, failure); r.diagnostics.fts = { available: false, searchFailed: true }; }
  assert.equal(obs.finish(r).lexical.state, 'unavailable');
});
test('no diagnostic gate stays blocked rather than inferred from final result', async () => {
  const f = fixture(), cap = b.createCapture(f.plan); f.chunks.forEach(c => cap.recordDocument(c, [1, 2, 3]));
  const obs = cap.beginQuestion('q-0'); await obs.wrapWorkerPool({ encodeQuery: () => encoding() }).encodeQuery(f.plan.questions[0].query);
  const row = obs.finish({ data: [] }); assert.equal(row.gate, null); assert.equal(row.rerank.reason, 'gate-unobservable'); assert.equal(row.lexical.state, 'blocked');
});
test('capture enforces sequential complete coverage and prohibits late instrumentation', async () => {
  const f = fixture(), cap = b.createCapture(f.plan); assert.throws(() => cap.beginQuestion('q-0'), { code: 'ORDER' });
  f.chunks.forEach(c => cap.recordDocument(c, [1, 2, 3])); assert.throws(() => cap.beginQuestion('q-1'), { code: 'ORDER' });
  const o = cap.beginQuestion('q-0'); assert.throws(() => cap.beginQuestion('q-0'), { code: 'ORDER' });
  const p = o.wrapWorkerPool({ encodeQuery: () => encoding(), rerank: () => [1] });
  await assert.rejects(p.encodeQuery('wrong'), { code: 'QUERY' }); await p.encodeQuery(f.plan.questions[0].query);
  await assert.rejects(p.encodeQuery(f.plan.questions[0].query), { code: 'QUERY' });
  await p.rerank({ query: encoding().colbert, docs: [{ colbert: new Int8Array(48), scale: 1 }], colbertDim: 48 });
  assert.throws(() => o.observeRerankIds(['doc-b']), { code: 'ORDER' }); o.finish(response(true));
  assert.throws(() => o.finish(response(true)), { code: 'ORDER' });
});
test('missing questions refuse and leave no output', t => rejectsMaterial(t, x => x.records.pop(), 'COVERAGE'));
test('extra question refuses', t => rejectsMaterial(t, x => x.records.push(clone(x.records.at(-1))), 'COVERAGE'));
test('question permutation refuses', t => rejectsMaterial(t, x => { [x.records[4], x.records[5]] = [x.records[5], x.records[4]]; }, 'COVERAGE'));
test('changed frozen question refuses', t => rejectsMaterial(t, x => { x.records[4].query = 'other'; }, 'COVERAGE'));
test('document ID coverage and permutation refuse', t => rejectsMaterial(t, x => { [x.records[1], x.records[2]] = [x.records[2], x.records[1]]; }, 'IDENTITY'));
test('changed original chunk refuses', t => rejectsMaterial(t, x => { x.records[1].chunk.content = 'changed'; }, 'IDENTITY'));
test('short document vectors refuse', t => rejectsMaterial(t, x => { x.records[1].graniteVector.values.pop(); }, 'VECTOR'));
test('nonfinite JSON numeric output refuses', async t => {
  const opts = files(t, await material()); const wire = fs.readFileSync(opts.materialPath, 'utf8').replace('"values":[0,1,2]', '"values":[1e400,1,2]');
  fs.writeFileSync(opts.materialPath, wire); assert.throws(() => b.processMaterial(opts), { code: 'NUMBER' }); assert.equal(fs.existsSync(opts.out), false);
});
test('nonfinite input helper refuses all nested numbers', () => {
  for (const v of [NaN, Infinity, -Infinity, { n: NaN }, new Float32Array([Infinity])]) assert.throws(() => b.snapshotWire(v), { code: 'NUMBER' });
  assert.throws(() => b.decodeWire({ $wire: 'Int8Array', values: [255] }), { code: 'WIRE' });
});
test('unknown lexical IDs refuse', t => rejectsMaterial(t, x => { x.records[4].lexical.calls[0].rows[0].id = 'unknown'; }, 'IDS'));
test('duplicate rerank IDs refuse', t => rejectsMaterial(t, x => { x.records[4].rerank.calls[0].candidateIds = ['doc-b', 'doc-b']; }, 'IDS'));
test('short score outputs refuse', t => rejectsMaterial(t, x => { x.records[4].rerank.calls[0].result.values.pop(); }, 'VECTOR'));
test('gate/call disagreement refuses', t => rejectsMaterial(t, x => { x.records[4].response.diagnostics.gate.rerankInvoked = false; x.records[4].gate.rerankInvoked = false; }, 'GATE'));
test('gate copied from elsewhere refuses', t => rejectsMaterial(t, x => { x.records[4].gate.threshold = 0.9; }, 'GATE'));
for (const [name, change] of [
  ['disabled but invoked', g => { g.requestedRerank = false; g.activated = false; }],
  ['activated without evaluation', g => { g.requestedRerank = false; g.evaluated = false; g.share = null; g.activated = true; }],
  ['requested and evaluated', g => { g.evaluated = true; g.share = 0.8; }],
  ['evaluated without share', g => { g.requestedRerank = false; g.evaluated = true; g.share = null; }],
  ['activated below threshold', g => { g.requestedRerank = false; g.evaluated = true; g.share = 0.3; g.activated = true; }],
  ['share outside unit range', g => { g.requestedRerank = false; g.evaluated = true; g.share = 1.1; g.activated = true; }],
]) test(`contradictory gate ${name} refuses even when both gate copies agree`, t => rejectsMaterial(t, x => {
  change(x.records[4].gate); x.records[4].response.diagnostics.gate = clone(x.records[4].gate);
}, 'GATE'));
test('invoked rerank with an empty pooled stage refuses', t => rejectsMaterial(t, x => { x.records[4].response.diagnostics.stages.pooled = 0; }, 'GATE'));
test('valid automatic activation and disabled-above-one threshold are retained', async t => {
  const automatic = await material({ invoke: true }); automatic.records = clone(automatic.records);
  for (const q of automatic.records.slice(4)) {
    q.gate = { requestedRerank: false, threshold: 0.7, evaluated: true, share: 0.7, activated: true, rerankInvoked: true };
    q.response.diagnostics.gate = clone(q.gate);
  }
  assert.equal(b.processMaterial(files(t, automatic)).counts.rerankInvoked, 30);
  const disabled = await material(); disabled.records = clone(disabled.records);
  for (const q of disabled.records.slice(4)) {
    q.gate = { requestedRerank: false, threshold: 1.1, evaluated: false, share: null, activated: false, rerankInvoked: false };
    q.response.diagnostics.gate = clone(q.gate);
  }
  assert.equal(b.processMaterial(files(t, disabled)).counts.rerankSkipped, 30);
});
test('enabled nonempty rerank cannot be declared skipped', async t => {
  const value = await material(); value.records = clone(value.records);
  const q = value.records[4]; q.gate = gate(true); q.gate.rerankInvoked = false; q.response.diagnostics.gate = clone(q.gate);
  q.rerank.reason = 'skip-reason-unobservable';
  const opts = files(t, value); assert.throws(() => b.processMaterial(opts), { code: 'GATE' }); assert.equal(fs.existsSync(opts.out), false);
});
test('successful lexical rows cannot coexist with failed/unavailable FTS diagnostics', t => rejectsMaterial(t, x => {
  x.records[4].response.diagnostics.fts = { available: false, searchFailed: true };
}, 'LEXICAL'));
test('empty ranking details contradict a known nonempty scored result', t => rejectsMaterial(t, x => {
  x.records[4].ranking = { structureWeights: [], priors: [], symbolAdditions: [] };
  x.records[4].response.data = [{ id: 'doc-b' }]; x.records[4].response.diagnostics.stages.scored = 3;
}, 'RANKING'));
test('partial and default-looking ranking details cannot establish full cohort coverage', async t => {
  const value = await material({ invoke: true }); value.records = clone(value.records);
  for (const q of value.records.slice(4)) {
    q.response.data = [{ id: 'doc-b' }]; q.response.diagnostics.stages.scored = 3;
    q.ranking = { structureWeights: [{ id: 'doc-b', value: 1 }], priors: [], symbolAdditions: [] };
  }
  const result = b.processMaterial(files(t, value));
  assert.equal(result.completeness.requiredObservationsComplete, false);
  for (const q of value.plan.questions) assert(result.blockers.includes(`${q.id}:ranking-coverage-unverified`));
});
test('empty ranking details for an empty result remain explicitly coverage-unverified', async t => {
  const value = await material(); value.records = clone(value.records);
  for (const q of value.records.slice(4)) q.ranking = { structureWeights: [], priors: [], symbolAdditions: [] };
  const result = b.processMaterial(files(t, value));
  assert.equal(result.completeness.requiredObservationsComplete, false);
  assert(result.blockers.includes('q-0:ranking-coverage-unverified'));
});
test('changed query matrix refuses', t => rejectsMaterial(t, x => { x.records[4].rerank.calls[0].input.query[0][0] = 0.75; }, 'VECTOR'));
test('changed baseline release refuses', t => rejectsMaterial(t, x => { x.plan.baseline.sourceCommit = REV; }, 'BASELINE'));
test('changed baseline lock refuses', t => rejectsMaterial(t, x => { x.plan.baseline.lockSha256 = H; }, 'BASELINE'));
test('changed source/scorer/adapter identity refuses', t => rejectsMaterial(t, x => { x.plan.identities.sourceTreeSha256 = '3'.repeat(64); }, 'IDENTITY'));
test('historical caches cannot declare current qualification', t => rejectsMaterial(t, x => { x.records[0].provenance = 'current-release'; }, 'PROVENANCE'));
test('missing artifact declarations remain blocked; no synthetic qualification escape', async t => {
  const value = await material(); value.plan.granite.artifacts = []; value.records = clone(value.records); value.records[0].granite.artifacts = [];
  value.records[0].planSha256 = b.wireHash(value.plan);
  const result = b.processMaterial(files(t, value)); assert(result.blockers.includes('granite-artifact-identity-missing')); assert.equal(result.currentRelease, false);
});
test('artifact paths cannot traverse or access caches', () => {
  for (const file of ['../cache', '/cache', 'a/../cache', 'a\\cache', 'a//b']) {
    const f = fixture(); f.plan.granite.artifacts[0].path = file; assert.throws(() => b.validatePlan(f.plan), { code: 'ARTIFACT' });
  }
});
test('existing output and symlinked input/parent paths refuse without touching targets', async t => {
  const opts = files(t, await material()); fs.mkdirSync(opts.out); fs.writeFileSync(path.join(opts.out, 'keep'), 'untouched');
  assert.throws(() => b.processMaterial(opts), { code: 'PATH' }); assert.equal(fs.readFileSync(path.join(opts.out, 'keep'), 'utf8'), 'untouched');
  const link = path.join(opts.dir, 'linked-plan'); fs.symlinkSync(opts.planPath, link);
  assert.throws(() => b.processMaterial({ ...opts, out: path.join(opts.dir, 'new'), planPath: link }), { code: 'PATH' });
  const parent = path.join(opts.dir, 'linked-parent'); fs.symlinkSync(opts.dir, parent);
  assert.throws(() => b.processMaterial({ ...opts, out: path.join(parent, 'new') }), { code: 'PATH' });
  assert.equal(fs.existsSync(path.join(opts.dir, 'new')), false);
});
test('relative, root, non-normalized and special-file inputs refuse', async t => {
  const opts = files(t, await material());
  for (const out of ['relative', '/', `${opts.dir}/../new`]) assert.throws(() => b.processMaterial({ ...opts, out }));
  assert.throws(() => b.processMaterial({ ...opts, planPath: '/dev/null' }), { code: 'PATH' });
});
test('oversized frames and malformed UTF8 refuse with cleanup', async t => {
  const opts = files(t, await material());
  for (const wire of [Buffer.alloc(b.LIMITS.lineBytes + 1, 32), Buffer.from([0xff, 10]), Buffer.from('{bad}\n')]) {
    fs.writeFileSync(opts.materialPath, wire); assert.throws(() => b.processMaterial(opts)); assert.equal(fs.existsSync(opts.out), false);
    assert.equal(fs.readdirSync(opts.dir).some(f => f.startsWith('.baseline-export-')), false);
  }
});
test('truncated final frame refuses rather than publishing partial', async t => {
  const opts = files(t, await material()); fs.truncateSync(opts.materialPath, fs.statSync(opts.materialPath).size - 1);
  assert.throws(() => b.processMaterial(opts), { code: 'WIRE' }); assert.equal(fs.existsSync(opts.out), false);
});
test('duplicate and escaped-duplicate JSON keys refuse without promotion', async t => {
  const value = await material(), opts = files(t, value), original = fs.readFileSync(opts.materialPath, 'utf8');
  for (const insert of ['"schemaVersion":1,"schemaVersion":1', '"schemaVersion":1,"schemaVersi\\u006fn":1']) {
    fs.writeFileSync(opts.materialPath, original.replace('"schemaVersion":1', insert));
    assert.throws(() => b.processMaterial(opts), { code: 'WIRE' }); assert.equal(fs.existsSync(opts.out), false);
  }
});
test('publication failure removes owned staging and reservation', async t => {
  const opts = files(t, await material()), originalRename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('synthetic publication failure'); };
    assert.throws(() => b.processMaterial(opts), /synthetic publication failure/);
  } finally { fs.renameSync = originalRename; }
  assert.equal(fs.existsSync(opts.out), false);
  assert.equal(fs.readdirSync(opts.dir).some(f => f.startsWith('.baseline-export-')), false);
});
test('plan may exceed one row bound while remaining within bounded metadata limit', () => {
  const f = fixture(), d = f.plan.documents[0]; f.plan.documents = Array.from({ length: 13000 }, (_, i) => ({ ...d, id: `chunk-${i}` }));
  assert(Buffer.byteLength(b.canonical(f.plan)) > b.LIMITS.lineBytes); assert.equal(b.validatePlan(f.plan).documents.length, 13000);
});
test('CLI validates/packs with explicit incomplete exit 2 and cannot enable infer/load', async t => {
  const opts = files(t, await material());
  const run = args => spawnSync(process.execPath, [FILE, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  let result = run(['validate', '--plan', opts.planPath, '--material', opts.materialPath]); assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).currentRelease, false); assert.equal(fs.existsSync(opts.out), false);
  result = run(['pack', '--plan', opts.planPath, '--material', opts.materialPath, '--out', opts.out]); assert.equal(result.status, 2); assert.equal(fs.existsSync(path.join(opts.out, 'result-manifest.json')), true);
  for (const op of ['infer', 'capture', 'load']) { result = run([op]); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).code, 'OPERATION'); }
  assert.equal(run(['--help']).status, 0); assert.throws(() => b.loadReleasedSearcher(), { code: 'RELEASE_LOADER_DISABLED' });
});
