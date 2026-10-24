'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { freeze, sha, provenance, scan, budget, args } = require('./freeze.cjs');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
function setup(t, preparedContent, sourceText = 'function answer() {\n  return 42;\n}\n') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'colbert-freeze-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'old'), ranking = path.join(root, 'ranking');
  const put = (base, file, value) => {
    const p = path.join(base, file), bytes = typeof value === 'string' ? value : encoded(value);
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return sha(bytes);
  };
  const text = sourceText, sourceHash = put(old, 'sources/code/a.ts', text);
  const fixture = { schemaVersion: 1, corpora: [{ id: 'code', root: 'sources/code' }],
    cases: [{ id: 'q1', corpus: 'code', split: 'heldout', origin: 'curated-source', intent: 'flow', query: 'Where is the answer?',
      expected: [{ file: 'a.ts', symbol: 'answer', match: 'range', startLine: 1, endLine: 3, sourceSha256: sourceHash }] }] };
  const fixturePath = path.join(ranking, 'fixture.json');
  const fixtureSha256 = put(ranking, 'fixture.json', fixture);
  const sm = { schemaVersion: 1, corpora: [{ id: 'code', originalRoot: '/original/code', snapshotRoot: 'sources/code',
    revision: 'a'.repeat(40), files: [{ path: 'a.ts', sha256: sourceHash, bytes: Buffer.byteLength(text), gitBlob: 'b'.repeat(40), role: 'candidate' }] }] };
  const sourceManifestHash = put(old, 'sources.json', sm);
  const id = sha('chunk'), content = preparedContent ?? text;
  const chunksHash = put(old, 'chunks.jsonl', JSON.stringify({ id, corpus: 'code', file: 'a.ts',
    path: path.join(old, 'sources/code/a.ts'), sourceSha256: sourceHash, content, contentSha256: sha(content),
    start_line: 0, end_line: 2, is_anchor: false }) + '\n');
  const cm = { schemaVersion: 1, totalChunks: 1, bytes: fs.statSync(path.join(old, 'chunks.jsonl')).size,
    sha256: chunksHash, files: [{ corpus: 'code', file: 'a.ts', chunks: 1, sourceSha256: sourceHash }] };
  const cmHash = put(old, 'chunk-manifest.json', cm);
  put(old, 'manifest.json', { artifacts: [{ path: 'sources.json', sha256: sourceManifestHash }] });
  const fh = put(old, 'colbert-features.jsonl', JSON.stringify({ id, colbert: Buffer.alloc(48).toString('base64'),
    scale: 0.1, pooled: Array(48).fill(0), tokenIds: [1] }) + '\n');
  const fmHash = put(old, 'colbert-features-manifest.json', { chunks: 1, sha256: fh, chunkSha256: chunksHash,
    model: { model: 'synthetic-model-only', revision: 'a'.repeat(40) } });
  const execution = { oldRoot: old, fixtureSha256, hashes: {
    [path.join(old, 'chunks.jsonl')]: chunksHash, [path.join(old, 'chunk-manifest.json')]: cmHash,
    [path.join(old, 'colbert-features-manifest.json')]: fmHash } };
  const executionHash = put(ranking, 'execution-manifest-v2.json', execution);
  const artifacts = {};
  for (const candidate of ['small', 'gemma']) for (const rep of [1, 2]) {
    const prefix = `pass-${candidate}-${rep}`, generation = sha(`synthetic-${candidate}`);
    artifacts[`${prefix}.queries.jsonl`] = put(ranking, `${prefix}.queries.jsonl`, JSON.stringify({ id: 'q1', generation,
      embedding: { generation, ids: ['q1'], vectors: [[1, 0]] }, features: { colbert: [Array(48).fill(0)] } }) + '\n');
    artifacts[`${prefix}.rankings.jsonl`] = put(ranking, `${prefix}.rankings.jsonl`, (rep === 1 ? ['baseline', 'fixed'] : ['fixed', 'baseline']).map(variant =>
      JSON.stringify({ id: 'q1', variant, response: { data: [], diagnostics: { schemaVersion: 1 } } })).join('\n') + '\n');
    artifacts[`${prefix}.json`] = put(ranking, `${prefix}.json`, { ok: true, candidate, repetition: rep,
      samples: [{ id: 'q1' }, { id: 'q1' }], generation, manifestSha256: executionHash,
      contract: { model: 'synthetic-model-only', dimensions: 2 }, outputHashes: {
        [`${prefix}.queries.jsonl`]: artifacts[`${prefix}.queries.jsonl`], [`${prefix}.rankings.jsonl`]: artifacts[`${prefix}.rankings.jsonl`] } });
  }
  for (const file of ['driver-source-original.ts', 'report-source-original.ts', 'baseline-searcher.ts', 'protocol-v2.json',
    'candidate-evidence-v3.json', 'independent-review-opus-v2.json', 'paired-report-v2.json', 'final-analysis.json', 'validation-final.json']) {
    artifacts[file] = put(ranking, file, 'Synthetic retained bytes; never executed.\n');
  }
  put(ranking, 'results-manifest.json', { artifacts });
  return { root, old, ranking, fixture, put, options: { fixture: fixturePath, evidenceRoot: old, rankingRoot: ranking,
    out: path.join(root, 'bundle'), expectedCases: 1, fixtureSha256 } };
}
test('freezes authentic bytes, labels, roots and hashes; historical stays historical; current is blocked', async t => {
  const s = setup(t), result = await freeze(s.options);
  assert.equal(result.status, 'incomplete'); assert.equal(result.sourcePreparation, 'verified');
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath));
  assert.deepEqual(manifest.counts, { sourceFiles: 1, preparedChunks: 1, answerSpans: 1, verifiedAnswerSpans: 1 });
  assert.equal(manifest.inferencePerformed, false); assert.equal(manifest.storesAccessed, false);
  assert.equal(manifest.answers[0].sourceSha256, s.fixture.cases[0].expected[0].sourceSha256);
  assert.equal(manifest.answers[0].sourceSpanSha256, sha('function answer() {\n  return 42;\n}'));
  assert.equal(manifest.answers[0].coveringChunkMatches[0].offsetUtf8Bytes, 0);
  assert.equal(manifest.rootMappings[0].originalRoot, '/original/code');
  assert.equal(manifest.historical.length, 4); assert.ok(manifest.historical.every(x => x.state === 'historical'));
  assert.equal(manifest.evidencePolicy.historicalCachesAreCurrentReleaseCandidates, false);
  assert.ok(manifest.missing.some(x => x.id === 'current-release-rerank-candidate-pools'));
  const feature = manifest.inventory.find(x => x.originalPath?.endsWith('colbert-features.jsonl'));
  assert.equal(feature.state, 'verified-local-reference'); assert.equal(feature.portable, false);
  assert.deepEqual(fs.readFileSync(path.join(s.options.out, 'sources/code/a.ts')), fs.readFileSync(path.join(s.old, 'sources/code/a.ts')));
  const second = await freeze({ ...s.options, out: path.join(s.root, 'second') });
  assert.equal(second.manifestSha256, result.manifestSha256, 'identical inputs yield deterministic manifests');
});
test('copy-large-evidence makes feature bytes portable without loading any model', async t => {
  const s = setup(t), result = await freeze({ ...s.options, copyLargeEvidence: true });
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath));
  const feature = manifest.inventory.find(x => x.path === 'historical/old/colbert-features.jsonl');
  assert.equal(feature.state, 'frozen'); assert.equal(feature.portable, true);
});
for (const [name, content] of [
  ['unrelated text', 'UNRELATED TEXT WITHOUT THE ANSWER'],
  ['missing first line', '  return 42;\n}'],
  ['missing last line', 'function answer() {\n  return 42;'],
]) test(`refuses ${name} despite valid covering coordinates and consistent cache hashes`, async t => {
  const s = setup(t, content);
  await assert.rejects(freeze(s.options), { code: 'ANSWER_CONTENT' });
  assert.equal(fs.existsSync(s.options.out), false);
  assert.deepEqual(fs.readdirSync(s.root).sort(), ['old', 'ranking']);
});
test('verifies an exact complete source span within prepared context and records UTF-8 offsets', async t => {
  const prefix = '// \u03c0 context\n', span = 'function answer() {\n  return 42;\n}';
  const s = setup(t, prefix + span + '\n// suffix');
  const result = await freeze(s.options), m = JSON.parse(fs.readFileSync(result.manifestPath));
  assert.equal(m.counts.verifiedAnswerSpans, 1);
  assert.deepEqual(m.answers[0].coveringChunkMatches, [{ id: sha('chunk'),
    offsetUtf8Bytes: Buffer.byteLength(prefix), bytes: Buffer.byteLength(span), sha256: sha(span) }]);
  assert.match(m.evidencePolicy.answerContentVerification, /no text normalization/);
});
test('source-span byte identity retains an initial UTF-8 BOM', async t => {
  const span = 'function answer() {\n  return 42;\n}';
  const s = setup(t, span, '\ufeff' + span + '\n');
  await assert.rejects(freeze(s.options), { code: 'ANSWER_CONTENT' });
  assert.equal(fs.existsSync(s.options.out), false);
  const good = setup(t, '\ufeff' + span, '\ufeff' + span + '\n');
  const result = await freeze(good.options), m = JSON.parse(fs.readFileSync(result.manifestPath));
  assert.equal(m.answers[0].sourceSpanSha256, sha('\ufeff' + span));
  assert.equal(m.answers[0].sourceSpanBytes, Buffer.byteLength('\ufeff' + span));
});
test('rejects source/hash mismatch and publishes no partial bundle', async t => {
  const s = setup(t); fs.appendFileSync(path.join(s.old, 'sources/code/a.ts'), '// drift');
  await assert.rejects(freeze(s.options), { code: 'HASH_MISMATCH' });
  assert.equal(fs.existsSync(s.options.out), false);
  assert.deepEqual(fs.readdirSync(s.root).sort(), ['old', 'ranking']);
});
test('rejects accepted-fixture hash mismatch before any output', async t => {
  const s = setup(t); await assert.rejects(freeze({ ...s.options, fixtureSha256: '0'.repeat(64) }), { code: 'HASH_MISMATCH' });
  assert.equal(fs.existsSync(s.options.out), false);
});
test('refuses incomplete required feature cache', async t => {
  const s = setup(t); fs.unlinkSync(path.join(s.old, 'colbert-features.jsonl'));
  await assert.rejects(freeze(s.options), { code: 'ENOENT' }); assert.equal(fs.existsSync(s.options.out), false);
});
test('refuses incomplete required ranking matrix', async t => {
  const s = setup(t); s.put(s.ranking, 'pass-small-1.rankings.jsonl', '');
  await assert.rejects(freeze(s.options), /Hash mismatch|Incomplete/);
  assert.equal(fs.existsSync(s.options.out), false);
});
for (const [name, startLine, endLine] of [['zero', 0, 2], ['reversed', 3, 2], ['beyond EOF', 1, 20]]) {
  test(`refuses ${name} answer bounds`, async t => {
    const s = setup(t); Object.assign(s.fixture.cases[0].expected[0], { startLine, endLine });
    const fixtureSha256 = s.put(s.ranking, 'fixture.json', s.fixture);
    const execution = JSON.parse(fs.readFileSync(path.join(s.ranking, 'execution-manifest-v2.json')));
    execution.fixtureSha256 = fixtureSha256; s.put(s.ranking, 'execution-manifest-v2.json', execution);
    await assert.rejects(freeze({ ...s.options, fixtureSha256 }), { code: 'ANSWER_BOUNDS' });
    assert.equal(fs.existsSync(s.options.out), false);
  });
}
test('refuses historical cache promotion to current-release outputs', () => {
  assert.throws(() => provenance('current-release', 'rerank-candidates'), { code: 'PROVENANCE' });
  assert.throws(() => provenance('current-release', 'query-vectors'), { code: 'PROVENANCE' });
  assert.equal(provenance('historical', 'rerank-candidates').state, 'historical');
  assert.equal(provenance('historical', 'rerank-candidates', { state: 'current-release' }).state, 'historical');
});
test('rejects source symlinks and traversal', async t => {
  const s = setup(t), p = path.join(s.old, 'sources/code/a.ts');
  fs.renameSync(p, p + '.real'); fs.symlinkSync(p + '.real', p);
  await assert.rejects(freeze(s.options), { code: 'SYMLINK' });
  const q = setup(t); q.fixture.cases[0].expected[0].file = '../secret';
  const fixtureSha256 = q.put(q.ranking, 'fixture.json', q.fixture);
  await assert.rejects(freeze({ ...q.options, fixtureSha256 }), { code: 'PATH' });
});
test('bounded JSONL reader refuses oversized/unterminated lines and malformed UTF-8', async t => {
  const s = setup(t), p = path.join(s.root, 'line.jsonl');
  fs.writeFileSync(p, '{"a":"long"}\n');
  await assert.rejects(scan(p, budget({ lineBytes: 4 })), { code: 'LINE_LIMIT' });
  fs.writeFileSync(p, '{}'); await assert.rejects(scan(p, budget()), { code: 'INCOMPLETE' });
  fs.writeFileSync(p, Buffer.from([0xff, 10])); await assert.rejects(scan(p, budget()), /encoded data/);
});
test('limits and command arguments fail closed', () => {
  assert.throws(() => budget({ fileBytes: Infinity }), { code: 'LIMIT' });
  assert.throws(() => budget({ outputBytes: 0 }), { code: 'LIMIT' });
  assert.throws(() => args(['--infer']), { code: 'ARGS' });
  assert.throws(() => args(['--out', 'a', '--out', 'b']), { code: 'ARGS' });
  assert.throws(() => args(['--fixture']), { code: 'ARGS' });
});
test('CLI documents arguments and refuses missing inputs without loading Gmax', () => {
  const cli = path.join(__dirname, 'freeze.cjs');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /--release-receipt/);
  const no = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(no.status, 1); assert.equal(JSON.parse(no.stderr).inferencePerformed, false);
});
test('rejects historical query generation drift even when row IDs are present', async t => {
  const s = setup(t), file = 'pass-small-1.queries.jsonl';
  const row = JSON.parse(fs.readFileSync(path.join(s.ranking, file), 'utf8'));
  row.embedding.generation = sha('wrong generation'); s.put(s.ranking, file, JSON.stringify(row) + '\n');
  await assert.rejects(freeze(s.options), { code: 'INCOMPLETE' });
  assert.equal(fs.existsSync(s.options.out), false);
});
test('rejects partial-answer chunks despite valid file and chunk hashes', async t => {
  const s = setup(t), row = JSON.parse(fs.readFileSync(path.join(s.old, 'chunks.jsonl'), 'utf8'));
  row.start_line = 1;
  const chunkHash = s.put(s.old, 'chunks.jsonl', JSON.stringify(row) + '\n');
  const cm = JSON.parse(fs.readFileSync(path.join(s.old, 'chunk-manifest.json')));
  cm.sha256 = chunkHash; cm.bytes = fs.statSync(path.join(s.old, 'chunks.jsonl')).size;
  const cmHash = s.put(s.old, 'chunk-manifest.json', cm);
  const execution = JSON.parse(fs.readFileSync(path.join(s.ranking, 'execution-manifest-v2.json')));
  execution.hashes[path.join(s.old, 'chunks.jsonl')] = chunkHash;
  execution.hashes[path.join(s.old, 'chunk-manifest.json')] = cmHash;
  s.put(s.ranking, 'execution-manifest-v2.json', execution);
  await assert.rejects(freeze(s.options), { code: 'ANSWER_CONTENT' });
  assert.equal(fs.existsSync(s.options.out), false);
});
test('accepted archive receipts remain hash-only unless exact bytes are supplied', async t => {
  const s = setup(t), archive = path.join(s.root, 'synthetic-archive.tgz'), receipt = path.join(s.root, 'receipt.json');
  fs.writeFileSync(archive, 'synthetic archive fixture');
  fs.writeFileSync(receipt, encoded({ version: '0.0.1', sha256: sha(fs.readFileSync(archive)) }));
  const first = await freeze({ ...s.options, releaseReceipt: receipt });
  const m = JSON.parse(fs.readFileSync(first.manifestPath)); assert.equal(m.release.archive.state, 'reported-hash-only');
  const second = await freeze({ ...s.options, out: path.join(s.root, 'with-archive'), releaseReceipt: receipt, releaseArchive: archive });
  const next = JSON.parse(fs.readFileSync(second.manifestPath));
  assert.equal(next.release.archive.state, 'verified-local-reference'); assert.equal(next.release.archive.copied, false);
  assert.equal(next.currentReleasePreparation, 'blocked');
  fs.appendFileSync(archive, 'drift');
  await assert.rejects(freeze({ ...s.options, out: path.join(s.root, 'bad-archive'), releaseReceipt: receipt, releaseArchive: archive }), { code: 'HASH_MISMATCH' });
});
test('projection metadata expected hash is checked without verifying original weight bytes', async t => {
  const s = setup(t), metadataPath = path.join(s.root, 'upstream.json');
  const orderedArtifacts = [['1_Dense/model.safetensors', sha('not downloaded')]];
  const metadata = { schemaVersion: 1, modelId: 'synthetic-upstream', revision: 'a'.repeat(40), inferencePerformed: false,
    weightsDownloaded: false, backbone: { expectedSha256: sha('metadata only') },
    projection: { orderedArtifacts, expectedAggregateSha256: sha(JSON.stringify(orderedArtifacts)) } };
  fs.writeFileSync(metadataPath, encoded(metadata));
  const result = await freeze({ ...s.options, upstreamMetadata: metadataPath });
  const m = JSON.parse(fs.readFileSync(result.manifestPath));
  assert.equal(m.upstream.state, 'metadata-only'); assert.equal(m.upstream.originalWeightBytesLocallyVerified, false);
  metadata.projection.expectedAggregateSha256 = '0'.repeat(64); fs.writeFileSync(metadataPath, encoded(metadata));
  await assert.rejects(freeze({ ...s.options, out: path.join(s.root, 'bad-projection'), upstreamMetadata: metadataPath }), { code: 'HASH_MISMATCH' });
});
