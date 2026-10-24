'use strict';

// Model-free observation/packing only. No product modules or runtimes are imported.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const PIN = Object.freeze({
  version: '0.26.96', sourceCommit: 'db7643cbfa42fa30d854078b42afb46d8ab04263',
  archiveSha256: '9f1499e71239228284ca47de25d3fceb7bfaa95564fc6a01a0afd00e28730ade',
  preparationCommit: '5df9af186a15be966a964cd0b7a9eaba50da94f9',
  fixtureSha256: 'b039ee9601f509abaaaf0f3c67b661476a4965a3df02612d1965792524b105c0',
  searcherSha256: 'fe22293abd8eeec04ec34f073cef91d4d31b21c74b4b27519835670def47ab1f',
  lockSha256: 'e581d5d1a179b30acdab6f93af914929f8e42cfe4e184da094510efbf8dd55af',
});
const LIMITS = Object.freeze({ planBytes: 16 * 1024 ** 2, lineBytes: 2 * 1024 ** 2,
  inputBytes: 512 * 1024 ** 2, outputBytes: 768 * 1024 ** 2, documents: 100000,
  array: 1000000, nodes: 1000000, depth: 32 });
const LATER_EXECUTION_LIMITS = Object.freeze({ aggregateRssBytes: 6 * 1024 ** 3,
  swapGrowthBytes: 512 * 1024 ** 2, experimentDiskBytes: 12 * 1024 ** 3,
  availableMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 15 * 1024 ** 3,
  sampleIntervalMs: 1000, deadlineMs: 30 * 60 * 1000 });
function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
function need(test, code, message) { if (!test) fail(code, message); }
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 256 && !/[\x00-\x1f]/.test(x);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const own = (x, key) => Object.prototype.hasOwnProperty.call(x, key);
function keys(x, expected) {
  need(object(x) && Object.keys(x).sort().join('|') === [...expected].sort().join('|'), 'SCHEMA', 'Unexpected or missing fields');
}
function canonical(x) {
  if (x === null || typeof x !== 'object') {
    need(x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)), 'NUMBER', 'Canonical JSON requires finite defined values');
    return JSON.stringify(x);
  }
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
}
function parseJSON(text) {
  const result = JSON.parse(text); let i = 0;
  const ws = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  function string() { const start = i++; while (i < text.length) { const c = text[i++]; if (c === '\\') i++; else if (c === '"') return text.slice(start, i); } fail('WIRE', 'Unterminated string'); }
  function value(depth) {
    need(depth <= LIMITS.depth, 'BOUND', 'JSON nesting bound exceeded'); ws();
    if (text[i] === '"') { string(); return; }
    if (text[i] === '{') {
      i++; ws(); const seen = new Set(); if (text[i] === '}') { i++; return; }
      for (;;) {
        ws(); const key = JSON.parse(string()); need(!seen.has(key), 'WIRE', 'Duplicate JSON key'); seen.add(key);
        ws(); i++; value(depth + 1); ws(); if (text[i++] === '}') return;
      }
    }
    if (text[i] === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      for (;;) { value(depth + 1); ws(); if (text[i++] === ']') return; }
    }
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
  }
  value(0); return result;
}
function freeze(x) { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }
const TYPES = { Buffer, Float32Array, Float64Array, Int8Array, Uint8Array, Uint8ClampedArray,
  Int16Array, Uint16Array, Int32Array, Uint32Array };
/** Copy immediately: later mutations of original arrays/buffers cannot alter evidence. */
function snapshot(value, maxBytes) {
  let nodes = 0;
  function visit(v, depth) {
    need(++nodes <= LIMITS.nodes && depth <= LIMITS.depth, 'BOUND', 'Observation exceeds structural bound');
    if (v === undefined) return { $wire: 'undefined' };
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { need(Number.isFinite(v), 'NUMBER', 'Nonfinite observation'); return Object.is(v, -0) ? { $wire: '-0' } : v; }
    if (typeof v === 'string') { need(Buffer.byteLength(v) <= LIMITS.lineBytes, 'BOUND', 'String too large'); return v; }
    if (ArrayBuffer.isView(v)) {
      const type = Buffer.isBuffer(v) ? 'Buffer' : v.constructor.name;
      need(own(TYPES, type) && v.length <= LIMITS.array, 'WIRE', 'Unsupported typed observation');
      return { $wire: type, values: Array.from(v, n => visit(n, depth + 1)) };
    }
    if (Array.isArray(v)) {
      need(v.length <= LIMITS.array, 'BOUND', 'Array too large');
      return Array.from(v, n => visit(n, depth + 1));
    }
    need(object(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && !own(v, '$wire'), 'WIRE', 'Only plain observable values are supported');
    const result = Object.create(null);
    for (const k of Object.keys(v)) result[k] = visit(v[k], depth + 1);
    return result;
  }
  const result = visit(value, 0);
  need(Buffer.byteLength(canonical(result)) <= maxBytes, 'BOUND', 'Observation too large');
  return freeze(result);
}
const snapshotWire = value => snapshot(value, LIMITS.lineBytes);
function decodeWire(value) {
  let nodes = 0;
  function visit(v, depth) {
    need(++nodes <= LIMITS.nodes && depth <= LIMITS.depth, 'BOUND', 'Wire structural bound exceeded');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { need(Number.isFinite(v), 'NUMBER', 'Nonfinite wire number'); return v; }
    if (Array.isArray(v)) { need(v.length <= LIMITS.array, 'BOUND', 'Wire array too large'); return v.map(n => visit(n, depth + 1)); }
    need(object(v), 'WIRE', 'Invalid wire value');
    if (own(v, '$wire')) {
      if (v.$wire === 'undefined' || v.$wire === '-0') { keys(v, ['$wire']); return v.$wire === '-0' ? -0 : undefined; }
      keys(v, ['$wire', 'values']);
      need(own(TYPES, v.$wire) && Array.isArray(v.values), 'WIRE', 'Invalid wire type');
      const values = visit(v.values, depth + 1);
      need(values.every(n => typeof n === 'number' && Number.isFinite(n)), 'NUMBER', 'Invalid typed number');
      const result = v.$wire === 'Buffer' ? Buffer.from(values) : new TYPES[v.$wire](values);
      need(values.every((n, i) => Object.is(n, result[i])), 'WIRE', 'Lossy typed wire values');
      return result;
    }
    const result = Object.create(null);
    for (const k of Object.keys(v)) result[k] = visit(v[k], depth + 1);
    return result;
  }
  return visit(value, 0);
}
const wireHash = x => sha256(canonical(x));
function vector(v, dim) {
  need((Array.isArray(v) || ArrayBuffer.isView(v)) && v.length === dim && Array.from(v).every(n => typeof n === 'number' && Number.isFinite(n)), 'VECTOR', 'Wrong or nonfinite vector dimensions');
}
function matrix(v, dim) { need(Array.isArray(v) && v.length > 0 && v.length <= 512, 'VECTOR', 'Invalid token matrix'); v.forEach(row => vector(row, dim)); }
function uniqueIds(rows, name) {
  need(Array.isArray(rows) && rows.every(r => object(r) && id(r.id)) && new Set(rows.map(r => r.id)).size === rows.length, 'IDS', `Invalid ${name} IDs`);
}
function model(m, colbert = false) {
  keys(m, ['modelId', 'revision', 'dimensions', 'precision', 'normalization', 'artifacts']);
  need(id(m.modelId) && /^[a-f0-9]{40}$/.test(m.revision) && Number.isSafeInteger(m.dimensions) && m.dimensions > 0 && m.dimensions <= 8192 && (!colbert || m.dimensions === 48) && id(m.precision) && id(m.normalization), 'IDENTITY', 'Invalid model identity');
  need(Array.isArray(m.artifacts) && m.artifacts.length <= 256, 'ARTIFACT', 'Invalid artifact declarations');
  const seen = new Set();
  for (const a of m.artifacts) {
    keys(a, ['path', 'sha256', 'bytes']);
    need(typeof a.path === 'string' && a.path.length <= 512 && !path.posix.isAbsolute(a.path) && !a.path.includes('\\') && a.path.split('/').every(p => p && p !== '.' && p !== '..') && digest(a.sha256) && Number.isSafeInteger(a.bytes) && a.bytes > 0 && !seen.has(a.path), 'ARTIFACT', 'Invalid artifact identity/path');
    seen.add(a.path);
  }
}
function validatePlan(input) {
  const plan = JSON.parse(canonical(snapshot(input, LIMITS.planBytes)));
  keys(plan, ['schemaVersion', 'baseline', 'identities', 'granite', 'colbert', 'documents', 'questions']);
  need(plan.schemaVersion === 1, 'SCHEMA', 'Invalid plan version');
  keys(plan.baseline, Object.keys(PIN));
  for (const [k, v] of Object.entries(PIN)) need(plan.baseline[k] === v, 'BASELINE', `Changed baseline ${k}`);
  keys(plan.identities, ['sourceManifestSha256', 'chunkManifestSha256', 'sourceTreeSha256', 'scorerSha256', 'evaluatorAdapterSha256']);
  need(Object.values(plan.identities).every(digest), 'IDENTITY', 'Missing source/scorer/adapter identity');
  model(plan.granite); model(plan.colbert, true);
  uniqueIds(plan.documents, 'document'); uniqueIds(plan.questions, 'question');
  need(plan.documents.length > 0 && plan.documents.length <= LIMITS.documents && plan.questions.length === 30, 'COVERAGE', 'Exactly 30 questions and a bounded complete document list required');
  for (const d of plan.documents) {
    keys(d, ['id', 'sourceId', 'sourceSha256', 'chunkWireSha256']);
    need(id(d.sourceId) && digest(d.sourceSha256) && digest(d.chunkWireSha256), 'IDENTITY', 'Missing chunk/source identity');
  }
  for (const q of plan.questions) {
    keys(q, ['id', 'query']); need(typeof q.query === 'string' && q.query.length > 0 && q.query.length <= 16384, 'QUERY', 'Invalid frozen query');
  }
  return freeze(plan);
}
function header(plan, provenance) {
  need(['synthetic', 'unverified-released-capture'].includes(provenance), 'PROVENANCE', 'Historical/current/qualified capture declarations refused');
  return freeze({ type: 'header', schemaVersion: 1, planSha256: wireHash(plan), baseline: plan.baseline,
    identities: plan.identities, granite: plan.granite, colbert: plan.colbert, provenance });
}
function validateHeader(row, plan) {
  const expected = header(plan, row.provenance);
  need(canonical(row) === canonical(expected), 'IDENTITY', 'Header/plan identity mismatch');
}
function validateDocument(row, expected, plan) {
  keys(row, ['type', 'id', 'sourceId', 'sourceSha256', 'chunk', 'graniteVector']);
  need(row.type === 'document' && row.id === expected.id && row.sourceId === expected.sourceId && row.sourceSha256 === expected.sourceSha256 && wireHash(row.chunk) === expected.chunkWireSha256, 'IDENTITY', 'Document order/source/content mismatch');
  const chunk = decodeWire(row.chunk);
  need(chunk.id === row.id && typeof chunk.content === 'string' && typeof chunk.path === 'string', 'CHUNK', 'Full original chunk id/path/content required');
  vector(decodeWire(row.graniteVector), plan.granite.dimensions);
}
function validateQuestion(row, expected, plan) {
  keys(row, ['type', 'id', 'query', 'encoding', 'lexical', 'gate', 'rerank', 'ranking', 'response']);
  need(row.type === 'question' && row.id === expected.id && row.query === expected.query, 'COVERAGE', 'Question identity/order mismatch');
  const encoding = decodeWire(row.encoding);
  vector(encoding.dense, plan.granite.dimensions);
  need(encoding.colbertDim === plan.colbert.dimensions, 'VECTOR', 'Query ColBERT dimension mismatch');
  matrix(encoding.colbert, plan.colbert.dimensions);
  if (encoding.pooled_colbert_48d !== undefined) vector(encoding.pooled_colbert_48d, 48);
  keys(row.lexical, ['state', 'calls', 'reason']);
  need(['observed', 'unavailable', 'blocked'].includes(row.lexical.state) && Array.isArray(row.lexical.calls) && row.lexical.calls.length <= 1 && typeof row.lexical.reason === 'string', 'LEXICAL', 'Invalid lexical observation');
  const docs = new Set(plan.documents.map(d => d.id));
  function candidateRows(rows) { uniqueIds(rows, 'candidate'); need(rows.every(r => docs.has(r.id)), 'IDS', 'Unknown candidate ID'); }
  for (const call of row.lexical.calls) { keys(call, ['query', 'rows']); need(call.query === row.query, 'QUERY', 'Lexical query mismatch'); candidateRows(decodeWire(call.rows)); }
  need((row.lexical.state === 'observed') === (row.lexical.calls.length === 1), 'LEXICAL', 'Missing lexical candidate observation');
  const response = decodeWire(row.response);
  need(object(response) && Array.isArray(response.data), 'RESPONSE', 'Original response required (empty data preserves misses)');
  if (row.lexical.state === 'unavailable') need(response.diagnostics?.fts?.available === false && row.lexical.reason === 'released-fts-unavailable', 'LEXICAL', 'Unsubstantiated FTS absence');
  if (row.lexical.state === 'blocked') need(row.lexical.reason === 'lexical-call-unobserved', 'LEXICAL', 'Unsubstantiated lexical blocker');
  if (row.lexical.state === 'observed') {
    need(row.lexical.reason === '', 'LEXICAL', 'Unexpected lexical reason');
    if (response.diagnostics?.fts) need(response.diagnostics.fts.available === true && response.diagnostics.fts.searchFailed === false,
      'LEXICAL', 'Successful lexical observation contradicts released FTS state');
  }
  const releasedGate = response.diagnostics?.gate;
  need(canonical(row.gate) === canonical(releasedGate ? snapshotWire(releasedGate) : null), 'GATE', 'Gate must be original released diagnostic detail');
  if (releasedGate) {
    for (const k of ['requestedRerank', 'evaluated', 'activated', 'rerankInvoked']) need(typeof releasedGate[k] === 'boolean', 'GATE', 'Malformed gate decision');
    const g = releasedGate;
    need(Number.isFinite(g.threshold) && g.threshold > 0, 'GATE', 'Invalid gate threshold');
    if (g.evaluated) need(!g.requestedRerank && g.threshold <= 1 && Number.isFinite(g.share) && g.share > 0 && g.share <= 1,
      'GATE', 'Evaluation requires an unrequested rerank and a valid concentration share');
    else need(g.share === null, 'GATE', 'Unevaluated gate cannot have a concentration share');
    need(g.activated === (g.evaluated && g.share >= g.threshold), 'GATE', 'Activation contradicts concentration evaluation');
    need(!g.rerankInvoked || g.requestedRerank || g.activated, 'GATE', 'Disabled rerank cannot be invoked');
    const pooled = response.diagnostics?.stages?.pooled;
    if (Number.isSafeInteger(pooled) && pooled >= 0) {
      need(g.evaluated === (!g.requestedRerank && pooled > 0 && g.threshold <= 1),
        'GATE', 'Evaluation contradicts requested rerank, threshold or known pooled stage');
      need(!g.rerankInvoked || pooled > 0, 'GATE', 'Empty pooled stage cannot invoke rerank');
      need(!(g.requestedRerank || g.activated) || pooled === 0 || g.rerankInvoked,
        'GATE', 'Enabled nonempty pooled stage must invoke released rerank');
    }
  }
  keys(row.rerank, ['state', 'reason', 'calls']);
  need(['invoked', 'skipped'].includes(row.rerank.state) && Array.isArray(row.rerank.calls) && row.rerank.calls.length <= 1, 'RERANK', 'Invalid rerank calls');
  need((row.rerank.state === 'invoked') === (row.rerank.calls.length === 1), 'RERANK', 'Rerank call/state mismatch');
  if (releasedGate) need(releasedGate.rerankInvoked === (row.rerank.state === 'invoked'), 'GATE', 'Observed calls disagree with gate');
  for (const call of row.rerank.calls) {
    keys(call, ['input', 'result', 'candidateIds']);
    const input = decodeWire(call.input), result = decodeWire(call.result);
    need(input.colbertDim === 48 && Array.isArray(input.docs) && input.docs.length > 0 && input.docs.length <= 1000, 'RERANK', 'Invalid rerank input');
    matrix(input.query, 48);
    need(canonical(snapshotWire(input.query)) === canonical(snapshotWire(encoding.colbert)), 'VECTOR', 'Rerank query changed from observed encoding');
    for (const d of input.docs) {
      need((Array.isArray(d.colbert) || ArrayBuffer.isView(d.colbert)) && d.colbert.length % 48 === 0 && d.colbert.length <= 512 * 48 && Array.from(d.colbert).every(n => Number.isInteger(n) && n >= -128 && n <= 255) && Number.isFinite(d.scale) && d.scale > 0, 'RERANK', 'Invalid quantized document');
      if (d.token_ids !== undefined) need(Array.isArray(d.token_ids) && d.token_ids.length <= 512 && d.token_ids.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647), 'RERANK', 'Invalid document token IDs');
    }
    vector(result, input.docs.length);
    if (call.candidateIds !== null) {
      need(Array.isArray(call.candidateIds) && call.candidateIds.length === input.docs.length && new Set(call.candidateIds).size === call.candidateIds.length && call.candidateIds.every(x => docs.has(x)), 'IDS', 'Invalid exact rerank ID coverage');
    }
  }
  if (row.rerank.state === 'skipped') {
    const reason = !releasedGate ? 'gate-unobservable' : !releasedGate.requestedRerank && !releasedGate.activated ? 'released-gate-disabled' : response.diagnostics?.stages?.pooled === 0 ? 'empty-candidate-pool' : 'skip-reason-unobservable';
    need(row.rerank.reason === reason, 'GATE', 'Unsubstantiated skipped-rerank reason');
  } else need(row.rerank.reason === null, 'RERANK', 'Invoked rerank cannot have skip reason');
  if (row.ranking !== null) {
    keys(row.ranking, ['structureWeights', 'priors', 'symbolAdditions']);
    for (const field of ['structureWeights', 'priors']) {
      uniqueIds(row.ranking[field], field);
      for (const x of row.ranking[field]) { keys(x, ['id', 'value']); need(docs.has(x.id) && typeof x.value === 'number' && Number.isFinite(x.value), 'RANKING', 'Malformed ranking observation'); }
    }
    need(Array.isArray(row.ranking.symbolAdditions) && new Set(row.ranking.symbolAdditions).size === row.ranking.symbolAdditions.length && row.ranking.symbolAdditions.every(x => docs.has(x)), 'RANKING', 'Invalid symbol additions');
    if (response.data.length > 0 || response.diagnostics?.stages?.scored > 0) need(row.ranking.structureWeights.length > 0,
      'RANKING', 'Empty structure observations contradict known nonempty scoring');
  }
}

/** One observer per question, sequential calls only. It never selects candidates or scores. */
function createCapture(inputPlan, { provenance = 'unverified-released-capture' } = {}) {
  const plan = validatePlan(inputPlan), first = header(plan, provenance);
  const documents = [], questions = []; let active = false, captureBytes = Buffer.byteLength(canonical(first)) + 1, observationFailure;
  const sound = () => { if (observationFailure) throw observationFailure; };
  // Released Searcher may catch dependency errors (notably FTS). An exporter
  // error after a successful dependency call must never become normal absence.
  const observed = fn => { sound(); try { return fn(); } catch (error) { observationFailure = error; throw error; } };
  const retain = row => { const bytes = Buffer.byteLength(canonical(row)) + 1; need(bytes <= LIMITS.lineBytes && captureBytes + bytes <= LIMITS.inputBytes, 'BOUND', 'Capture byte limit exceeded'); captureBytes += bytes; return freeze(row); };
  return Object.freeze({
    plan,
    recordDocument(chunk, dense) {
      need(!active && questions.length === 0 && documents.length < plan.documents.length, 'ORDER', 'Documents must precede questions');
      const expected = plan.documents[documents.length];
      const row = { type: 'document', id: chunk.id, sourceId: expected.sourceId, sourceSha256: expected.sourceSha256,
        chunk: snapshotWire(chunk), graniteVector: snapshotWire(dense) };
      validateDocument(row, expected, plan); documents.push(retain(row));
    },
    beginQuestion(questionId) {
      sound();
      need(!active && documents.length === plan.documents.length && questions.length < 30 && plan.questions[questions.length].id === questionId, 'ORDER', 'Question order/coverage mismatch');
      active = true;
      const q = plan.questions[questions.length]; let done = false, encoding, encodeStarted = false, rerankStarted = false, ranking = null, ids = null, inFlight = 0;
      const calls = [], lexicalCalls = [];
      const live = () => { sound(); need(!done, 'ORDER', 'Question already finished'); };
      const observeLexical = (query, rows) => observed(() => { live(); need(lexicalCalls.length === 0 && query === q.query, 'LEXICAL', 'Duplicate/changed lexical query'); lexicalCalls.push(freeze({ query, rows: snapshotWire(rows) })); });
      function wrapQuery(builder, text) {
        return new Proxy(builder, { get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'toArray') return async (...args) => { live(); inFlight++; try { const rows = await value.apply(target, args); observeLexical(text, rows); return rows; } finally { inFlight--; } };
          return typeof value === 'function' ? (...args) => { const result = value.apply(target, args); return object(result) ? wrapQuery(result, text) : result; } : value;
        } });
      }
      return Object.freeze({
        wrapWorkerPool(pool) {
          return new Proxy(pool, { get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (prop === 'encodeQuery') return async (...args) => {
              live(); need(!encodeStarted && args[0] === q.query, 'QUERY', 'Duplicate/changed encode query'); encodeStarted = true; inFlight++;
              try { const result = await value.apply(target, args); encoding = observed(() => snapshotWire(result)); return result; } finally { inFlight--; }
            };
            if (prop === 'rerank') return async (...args) => {
              live(); need(!rerankStarted && encoding, 'ORDER', 'Duplicate or premature rerank'); rerankStarted = true; inFlight++;
              try { const input = observed(() => snapshotWire(args[0])), candidateIds = ids; const result = await value.apply(target, args); calls.push(observed(() => freeze({ input, result: snapshotWire(result), candidateIds }))); return result; } finally { inFlight--; }
            };
            return typeof value === 'function' ? value.bind(target) : value;
          } });
        },
        wrapDatabase(db) {
          return new Proxy(db, { get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (prop === 'ensureTable') return async (...args) => {
              const table = await value.apply(target, args);
              return new Proxy(table, { get(t, p) { const v = Reflect.get(t, p, t); return p === 'search' ? (...a) => wrapQuery(v.apply(t, a), a[0]) : typeof v === 'function' ? v.bind(t) : v; } });
            };
            return typeof value === 'function' ? value.bind(target) : value;
          } });
        },
        // Requires a new explicitly reviewed evaluator observation hook. Not inferred.
        observeRanking(value) { live(); need(ranking === null, 'ORDER', 'Duplicate ranking observation'); ranking = observed(() => snapshotWire(value)); },
        observeRerankIds(value) { live(); need(ids === null && !rerankStarted && encoding && inFlight === 0, 'ORDER', 'IDs must be observed before actual rerank boundary'); ids = observed(() => snapshotWire(value)); },
        finish(response) {
          live(); need(inFlight === 0 && encoding, 'ORDER', 'Incomplete dependency calls');
          const original = snapshotWire(response), gate = response.diagnostics?.gate ? snapshotWire(response.diagnostics.gate) : null;
          const reason = calls.length ? null : !gate ? 'gate-unobservable' : !gate.requestedRerank && !gate.activated ? 'released-gate-disabled' : response.diagnostics?.stages?.pooled === 0 ? 'empty-candidate-pool' : 'skip-reason-unobservable';
          const row = { type: 'question', id: q.id, query: q.query, encoding,
            lexical: { state: lexicalCalls.length ? 'observed' : response.diagnostics?.fts?.available === false ? 'unavailable' : 'blocked', calls: lexicalCalls,
              reason: lexicalCalls.length ? '' : response.diagnostics?.fts?.available === false ? 'released-fts-unavailable' : 'lexical-call-unobserved' },
            gate, rerank: { state: calls.length ? 'invoked' : 'skipped', reason, calls }, ranking, response: original };
          validateQuestion(row, q, plan); questions.push(retain(row)); done = true; active = false; return questions.at(-1);
        },
      });
    },
    records() { sound(); need(!active && documents.length === plan.documents.length && questions.length === 30, 'COVERAGE', 'Partial capture cannot be exported'); return Object.freeze([first, ...documents, ...questions]); },
  });
}

function loadReleasedSearcher() {
  fail('RELEASE_LOADER_DISABLED', 'No reviewed isolated release loader: require verified immutable release imports/dependencies and evaluator hooks for exact rerank IDs, structure weights/priors and symbol additions');
}
function checkPath(file, directory = false) {
  need(typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0'), 'PATH', 'Absolute paths required');
  const normalized = path.normalize(file);
  need(normalized === file && file !== path.parse(file).root, 'PATH', 'Normalized non-root paths required');
  const parts = file.split(path.sep).filter(Boolean); let current = path.parse(file).root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const st = fs.lstatSync(current);
    need(!st.isSymbolicLink() && (i === parts.length - 1 && !directory ? st.isFile() : st.isDirectory()), 'PATH', 'Symlink or nonregular path refused');
  }
  return file;
}
function openInput(file, max) {
  checkPath(file); const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.size > max) { fs.closeSync(fd); fail('BOUND', 'Input file limit exceeded'); }
  return fd;
}
function readPlan(file) {
  const fd = openInput(file, LIMITS.planBytes);
  try {
    const buf = Buffer.alloc(LIMITS.planBytes + 1); let n = 0, got;
    do { got = fs.readSync(fd, buf, n, buf.length - n, null); n += got; } while (got && n < buf.length);
    need(n <= LIMITS.planBytes, 'BOUND', 'Plan input too large');
    return validatePlan(parseJSON(new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n))));
  } finally { fs.closeSync(fd); }
}
function* lines(file, state) {
  const fd = openInput(file, LIMITS.inputBytes), buffer = Buffer.alloc(64 * 1024); let pending = Buffer.alloc(0);
  try {
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break;
      state.bytes += n; need(state.bytes <= LIMITS.inputBytes, 'BOUND', 'Input byte limit exceeded'); state.hash.update(buffer.subarray(0, n));
      pending = Buffer.concat([pending, buffer.subarray(0, n)]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        need(end > 0 && end + 1 <= LIMITS.lineBytes, 'BOUND', 'Empty or oversized JSONL frame');
        const bytes = pending.subarray(0, end + 1); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        yield { row: parseJSON(text), bytes }; pending = pending.subarray(end + 1);
      }
      need(pending.length < LIMITS.lineBytes, 'BOUND', 'Oversized JSONL frame');
    }
    need(pending.length === 0, 'WIRE', 'Final JSONL newline required');
  } finally { fs.closeSync(fd); }
}
function blockersFor(row) {
  const out = [];
  if (!row.gate) out.push(`${row.id}:released-gate-unobserved`);
  if (row.lexical.state === 'blocked') out.push(`${row.id}:lexical-candidates-unobserved`);
  if (row.rerank.calls.some(c => c.candidateIds === null)) out.push(`${row.id}:exact-rerank-chunk-ids-unobserved`);
  if (row.rerank.reason === 'skip-reason-unobservable') out.push(`${row.id}:skip-reason-unobservable`);
  if (!row.ranking) out.push(`${row.id}:structure-weights-priors-symbol-additions-unobserved`);
  else out.push(`${row.id}:ranking-coverage-unverified`);
  return out;
}
/** Validate ordered JSONL, optionally pack it into an atomic private fresh directory. */
function processMaterial({ planPath, materialPath, out }) {
  const plan = readPlan(planPath), state = { bytes: 0, hash: crypto.createHash('sha256') };
  let stage, destination, reservation, outputBytes = 0, streamFd, recordCount = 0, invoked = 0, skipped = 0, observationsComplete = true;
  const blockers = ['release-source-archive-adapter-scorer-lock-equivalence-unverified', 'frozen-fixture-source-chunk-inventories-unverified', 'model-artifact-bytes-and-runtime-unqualified', 'isolated-execution-gate-not-selected'];
  if (!plan.granite.artifacts.length) blockers.push('granite-artifact-identity-missing');
  if (!plan.colbert.artifacts.length) blockers.push('colbert-artifact-identity-missing');
  function write(file, bytes) {
    outputBytes += bytes.length; need(outputBytes <= LIMITS.outputBytes, 'BOUND', 'Output limit exceeded');
    const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  try {
    if (out !== undefined) {
      need(typeof out === 'string' && path.isAbsolute(out) && path.normalize(out) === out, 'PATH', 'Normalized absolute output required');
      checkPath(path.dirname(out), true);
      need(!fs.existsSync(out), 'PATH', 'Output must be fresh');
      // Claim an empty destination; rename replaces only this owned empty directory.
      fs.mkdirSync(out, { mode: 0o700 }); destination = out; reservation = fs.lstatSync(out);
      stage = fs.mkdtempSync(path.join(path.dirname(out), '.baseline-export-')); fs.chmodSync(stage, 0o700);
      streamFd = fs.openSync(path.join(stage, 'material.jsonl'), 'wx', 0o600);
    }
    const wireRows = []; const wireFdPath = stage && path.join(stage, 'wire-hashes.jsonl');
    let headerRow;
    for (const { row, bytes } of lines(materialPath, state)) {
      if (recordCount === 0) { validateHeader(row, plan); headerRow = row; }
      else if (recordCount <= plan.documents.length) validateDocument(row, plan.documents[recordCount - 1], plan);
      else {
        const index = recordCount - plan.documents.length - 1;
        need(index < 30, 'COVERAGE', 'Extra material records'); validateQuestion(row, plan.questions[index], plan);
        const missing = blockersFor(row); blockers.push(...missing); observationsComplete &&= missing.length === 0;
        row.rerank.state === 'invoked' ? invoked++ : skipped++;
      }
      const parts = row.type === 'document' ? { chunk: wireHash(row.chunk), graniteVector: wireHash(row.graniteVector) }
        : row.type === 'question' ? { encoding: wireHash(row.encoding), lexical: wireHash(row.lexical), gate: wireHash(row.gate), ranking: wireHash(row.ranking), response: wireHash(row.response),
          rerank: row.rerank.calls.map(c => ({ input: wireHash(c.input), result: wireHash(c.result), candidateIds: wireHash(c.candidateIds) })) } : {};
      wireRows.push(canonical({ index: recordCount, type: row.type, id: row.id ?? null, bytes: bytes.length, rawSha256: sha256(bytes), valueSha256: wireHash(row), parts }) + '\n');
      if (streamFd !== undefined) { outputBytes += bytes.length; need(outputBytes <= LIMITS.outputBytes, 'BOUND', 'Output limit exceeded'); fs.writeFileSync(streamFd, bytes); }
      recordCount++;
    }
    need(recordCount === 1 + plan.documents.length + 30, 'COVERAGE', 'Missing documents/questions/header; no partial output');
    if (headerRow.provenance === 'synthetic') blockers.unshift('synthetic-observations-not-runtime-evidence');
    if (streamFd !== undefined) { fs.fsyncSync(streamFd); fs.closeSync(streamFd); streamFd = undefined; }
    const manifest = { schemaVersion: 1, component: 'released-baseline-export', status: 'incomplete', currentRelease: false,
      qualification: 'unqualified', inferencePerformedByExporter: false, actualReleaseLoading: 'disabled',
      planSha256: wireHash(plan), materialSha256: state.hash.digest('hex'), materialBytes: state.bytes,
      baseline: plan.baseline, identities: plan.identities, granite: plan.granite, colbert: plan.colbert,
      provenance: headerRow.provenance, counts: { documents: plan.documents.length, questions: 30, rerankInvoked: invoked, rerankSkipped: skipped },
      completeness: { orderedDocumentAndQuestionCoverage: true, requiredObservationsComplete: observationsComplete },
      laterExecutionLimits: LATER_EXECUTION_LIMITS, blockers };
    if (stage) {
      write(wireFdPath, Buffer.from(wireRows.join('')));
      manifest.wireHashesSha256 = sha256(fs.readFileSync(wireFdPath));
      write(path.join(stage, 'plan.json'), Buffer.from(canonical(plan) + '\n'));
      write(path.join(stage, 'result-manifest.json'), Buffer.from(canonical(manifest) + '\n'));
      const current = fs.lstatSync(destination);
      need(current.dev === reservation.dev && current.ino === reservation.ino && current.isDirectory() && !current.isSymbolicLink(), 'PATH', 'Output reservation changed');
      fs.renameSync(stage, destination); stage = undefined; destination = undefined;
    }
    return freeze(manifest);
  } finally {
    if (streamFd !== undefined) fs.closeSync(streamFd);
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    if (destination && fs.existsSync(destination)) {
      const current = fs.lstatSync(destination);
      if (current.dev === reservation.dev && current.ino === reservation.ino && current.isDirectory()) fs.rmdirSync(destination);
    }
  }
}
const HELP = `Model-free released baseline material validation/packing (no inference):
  node scripts/colbert-eval/baseline-export.cjs validate --plan ABS_JSON --material ABS_JSONL
  node scripts/colbert-eval/baseline-export.cjs pack --plan ABS_JSON --material ABS_JSONL --out ABS_NEW_DIR
Successful preparation exits 2: every output remains incomplete/non-current/unqualified.
Invalid input exits 1 and leaves no promoted output. --help exits 0.
Only validate/pack exist; actual release loading and public infer remain disabled.
See BASELINE-EXPORT.md for capture API, schema, bounds, evidence and blockers.\n`;
function cli(args) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(HELP); return 0; }
  const operation = args.shift(); need(['validate', 'pack'].includes(operation), 'OPERATION', 'Only validate/pack are enabled');
  const flags = { '--plan': 'planPath', '--material': 'materialPath', '--out': 'out' }, opts = {};
  while (args.length) { const key = flags[args.shift()]; need(key && !own(opts, key) && args.length > 0, 'ARGS', 'Unknown/duplicate/missing argument'); opts[key] = args.shift(); }
  need(opts.planPath && opts.materialPath && (operation === 'pack' ? opts.out : !opts.out), 'ARGS', 'Missing or inappropriate path argument');
  process.stdout.write(canonical(processMaterial(opts)) + '\n'); return 2;
}
module.exports = { PIN, LIMITS, LATER_EXECUTION_LIMITS, canonical, sha256, snapshotWire, decodeWire, wireHash,
  validatePlan, validateHeader, validateDocument, validateQuestion, createCapture, loadReleasedSearcher, processMaterial, cli };
if (require.main === module) {
  try { process.exitCode = cli(process.argv.slice(2)); }
  catch (e) { process.stderr.write(canonical({ ok: false, code: e.code || 'INVALID', message: 'Baseline material refused; no output promoted' }) + '\n'); process.exitCode = 1; }
}
