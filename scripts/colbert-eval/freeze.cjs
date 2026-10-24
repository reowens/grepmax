#!/usr/bin/env node
'use strict';
/**
 * Wave 1 local-only preparation. Node stdlib only; never imports Gmax or a store.
 * See --help. No model execution operation exists. Historical evidence stays historical.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const FIXTURE_SHA256 = 'b039ee9601f509abaaaf0f3c67b661476a4965a3df02612d1965792524b105c0';
const MiB = 1024 ** 2;
const LIMITS = Object.freeze({ fileBytes: 512 * MiB, metadataBytes: 16 * MiB,
  sourceBytes: 2 * MiB, totalReadBytes: 1536 * MiB, outputBytes: 768 * MiB,
  lineBytes: 2 * MiB, rows: 100000, files: 1800 });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, null, 2) + '\n';
function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
function need(value, code, message) { if (!value) fail(code, message); }
function hash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function relative(value) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value) &&
    value.split('/').every(p => p && p !== '.' && p !== '..'), 'PATH', 'Unsafe relative path');
  return value;
}
function regular(file) {
  const abs = path.resolve(file), parts = abs.split(path.sep).filter(Boolean);
  let here = path.parse(abs).root;
  for (const part of parts) {
    here = path.join(here, part);
    const s = fs.lstatSync(here);
    need(!s.isSymbolicLink(), 'SYMLINK', 'Symlink inputs are refused');
  }
  const s = fs.statSync(abs);
  need(s.isFile(), 'FILE_TYPE', 'Regular file required');
  return s;
}
function utf8(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function budget(limits = {}) {
  const cap = { ...LIMITS, ...limits };
  for (const key of Object.keys(cap)) need(key in LIMITS && Number.isSafeInteger(cap[key]) &&
    cap[key] > 0 && cap[key] <= LIMITS[key], 'LIMIT', 'Invalid or excessive read/output limit');
  let read = 0, written = 0, files = 0;
  return {
    cap,
    read(n) { read += n; need(read <= cap.totalReadBytes, 'READ_LIMIT', 'Total read limit exceeded'); },
    file() { need(++files <= cap.files, 'FILE_LIMIT', 'File count exceeded'); },
    write(n) { written += n; need(written <= cap.outputBytes, 'OUTPUT_LIMIT', 'Output limit exceeded'); },
    stats() { return { bytesRead: read, bytesWritten: written, filesRead: files }; },
  };
}
function read(file, b, max = b.cap.metadataBytes) {
  const s = regular(file); b.file();
  need(s.size <= max, 'FILE_LIMIT', 'File byte limit exceeded');
  // Open + fstat and read a fixed bounded amount rather than an unbounded readFile.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const initial = fs.fstatSync(fd);
    need(initial.size === s.size && initial.ino === s.ino, 'CHANGED', 'Input changed before read');
    const buf = Buffer.alloc(initial.size + 1); let n = 0, count;
    while (n < buf.length && (count = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += count;
    b.read(n);
    need(n === initial.size && fs.fstatSync(fd).mtimeMs === initial.mtimeMs, 'CHANGED', 'Input changed during read');
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}
function json(file, b) { return JSON.parse(utf8(read(file, b))); }
function write(file, bytes, b) {
  b.write(Buffer.byteLength(bytes)); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}
function record(file, bytes, state = 'frozen') {
  return { path: file, bytes: bytes.length, sha256: sha(bytes), state };
}
async function scan(file, b, onRow = () => {}, destination) {
  const before = regular(file); b.file();
  need(before.size <= b.cap.fileBytes, 'FILE_LIMIT', 'Evidence byte limit exceeded');
  const digest = crypto.createHash('sha256'); let pending = Buffer.alloc(0), bytes = 0, rows = 0;
  let output;
  if (destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    output = fs.openSync(destination, 'wx', 0o600);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const initial = fs.fstatSync(fd);
    need(initial.ino === before.ino && initial.size === before.size, 'CHANGED', 'Input changed before stream');
    const blockBuffer = Buffer.alloc(64 * 1024);
    for (let count; (count = fs.readSync(fd, blockBuffer, 0, blockBuffer.length, null)) > 0;) {
      const block = blockBuffer.subarray(0, count);
      bytes += block.length; b.read(block.length);
      need(bytes <= b.cap.fileBytes, 'FILE_LIMIT', 'Growing input exceeded byte limit');
      digest.update(block);
      if (output !== undefined) { b.write(block.length); fs.writeSync(output, block); }
      pending = Buffer.concat([pending, block]);
      let end;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
        need(line.length > 0 && line.length <= b.cap.lineBytes, 'LINE_LIMIT', 'Empty or excessive JSONL line');
        need(++rows <= b.cap.rows, 'ROW_LIMIT', 'JSONL row cap exceeded');
        onRow(JSON.parse(utf8(line)), rows - 1);
      }
      need(pending.length <= b.cap.lineBytes, 'LINE_LIMIT', 'JSONL line cap exceeded');
    }
    need(pending.length === 0, 'INCOMPLETE', 'JSONL must end with a newline');
    need(bytes === before.size && fs.fstatSync(fd).mtimeMs === before.mtimeMs, 'CHANGED', 'Input changed during stream');
    return { bytes, sha256: digest.digest('hex'), rows };
  } finally { fs.closeSync(fd); if (output !== undefined) fs.closeSync(output); }
}
function assertDigest(actual, expected, label) {
  need(hash(expected) && actual === expected, 'HASH_MISMATCH', `Hash mismatch: ${label}`);
}
function validateFixture(fixture, expectedCases) {
  need(fixture.schemaVersion === 1 && Array.isArray(fixture.corpora) && fixture.corpora.length > 0 &&
    Array.isArray(fixture.cases) && fixture.cases.length === expectedCases, 'INCOMPLETE', 'Incomplete fixture');
  const corpora = new Map(), ids = new Set();
  for (const c of fixture.corpora) {
    relative(c.id); relative(c.root);
    need(!corpora.has(c.id), 'DUPLICATE', 'Duplicate corpus'); corpora.set(c.id, c);
  }
  for (const c of fixture.cases) {
    need(typeof c.id === 'string' && c.id && !ids.has(c.id) && corpora.has(c.corpus) &&
      typeof c.query === 'string' && c.query.trim() && c.query.length <= 16384 &&
      Array.isArray(c.expected) && c.expected.length > 0, 'INCOMPLETE', 'Missing or duplicate case data');
    ids.add(c.id);
    for (const target of c.expected) {
      relative(target.file);
      need(target.match === 'range' && hash(target.sourceSha256) && Number.isSafeInteger(target.startLine) &&
        Number.isSafeInteger(target.endLine) && target.startLine > 0 && target.endLine >= target.startLine,
      'ANSWER_BOUNDS', 'Invalid answer span/hash');
    }
  }
  return corpora;
}
function provenance(state, kind, detail = {}) {
  need(['historical', 'current-release', 'missing', 'blocked'].includes(state), 'PROVENANCE', 'Unknown provenance state');
  // This component cannot promote any cache to current: no accepted release execution gate exists in Wave 1.
  need(state !== 'current-release' || kind === 'source-identity' || kind === 'archive-receipt',
    'PROVENANCE', 'Current-release execution evidence requires a later gate');
  return { ...detail, state, kind };
}
const RELEASE_FILES = ['package.json', 'pnpm-lock.yaml', 'src/lib/search/searcher.ts',
  'src/lib/search/diagnostics.ts', 'src/lib/search/artifact-preference.ts',
  'src/lib/workers/embeddings/colbert.ts', 'src/lib/workers/colbert-tokenizer.ts',
  'src/lib/workers/orchestrator.ts', 'src/lib/eval/relevance-baseline.ts', 'src/config.ts'];
function releaseIdentity(options, stage, b) {
  const result = { state: 'incomplete', requestedRef: options.releaseRef || null,
    archive: { state: 'missing', reason: 'Accepted archive bytes not supplied; no network fallback.' },
    source: { state: 'missing', reason: 'No released source ref supplied.' } };
  if (options.releaseReceipt) {
    const raw = read(options.releaseReceipt, b), receipt = JSON.parse(utf8(raw));
    need(typeof receipt.version === 'string' && /^\d+\.\d+\.\d+$/.test(receipt.version) &&
      hash(receipt.sha256), 'RELEASE_RECEIPT', 'Invalid archive receipt');
    write(path.join(stage, 'release/archive-receipt.json'), raw, b);
    result.archive = { ...provenance('current-release', 'archive-receipt'),
      state: 'reported-hash-only', version: receipt.version, expectedSha256: receipt.sha256,
      receipt: record('release/archive-receipt.json', raw),
      limitation: 'Existing local receipt only; archive not downloaded, installed or executed.' };
    if (options.releaseArchive) {
      const bytes = read(options.releaseArchive, b, b.cap.fileBytes);
      assertDigest(sha(bytes), receipt.sha256, 'released archive');
      result.archive = { ...result.archive, state: 'verified-local-reference',
        localPath: path.resolve(options.releaseArchive), bytes: bytes.length,
        sha256: sha(bytes), copied: false };
    }
  } else need(!options.releaseArchive, 'RELEASE_RECEIPT', 'Archive requires an accepted receipt');
  if (options.releaseRef) {
    need(/^v\d+\.\d+\.\d+$/.test(options.releaseRef), 'RELEASE_REF', 'Use an explicit local version tag');
    const git = args => execFileSync('git', ['-C', options.repoRoot, ...args], {
      encoding: null, timeout: 10000, maxBuffer: 4 * MiB, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' } });
    const commit = utf8(git(['rev-parse', '--verify', `${options.releaseRef}^{commit}`])).trim();
    need(/^[a-f0-9]{40}$/.test(commit), 'RELEASE_REF', 'Unresolved release commit');
    const files = [];
    for (const file of RELEASE_FILES) {
      const bytes = git(['show', `${commit}:${file}`]); b.read(bytes.length); b.file();
      need(bytes.length <= b.cap.metadataBytes, 'FILE_LIMIT', 'Released source exceeds limit');
      write(path.join(stage, 'release/source', file), bytes, b);
      files.push(record(file, bytes));
    }
    const pkg = JSON.parse(utf8(fs.readFileSync(path.join(stage, 'release/source/package.json'))));
    need(`v${pkg.version}` === options.releaseRef && (!result.archive.version ||
      pkg.version === result.archive.version), 'RELEASE_REF', 'Tag/package/receipt version mismatch');
    result.source = { ...provenance('current-release', 'source-identity'), commit,
      version: pkg.version, files, workingTreeIncluded: false,
      limitation: 'Local version tag identity; source-to-public-archive equivalence is not requalified here.' };
  }
  return result;
}
async function freeze(options) {
  const o = { expectedCases: 30, fixtureSha256: FIXTURE_SHA256, copyLargeEvidence: false,
    repoRoot: process.cwd(), ...options };
  need(Number.isSafeInteger(o.expectedCases) && o.expectedCases > 0 && o.expectedCases <= 256,
    'LIMIT', 'Invalid expected case count');
  for (const key of ['fixture', 'evidenceRoot', 'rankingRoot', 'out']) need(typeof o[key] === 'string' && o[key], 'ARGS', `Missing ${key}`);
  for (const key of ['fixture', 'evidenceRoot', 'rankingRoot', 'out', 'repoRoot']) o[key] = path.resolve(o[key]);
  need(!fs.existsSync(o.out), 'OUTPUT_EXISTS', 'Output must be a new directory');
  for (const root of [o.evidenceRoot, o.rankingRoot]) need(!o.out.startsWith(root + path.sep) &&
    !root.startsWith(o.out + path.sep) && root !== o.out, 'PATH', 'Output must be separate from retained inputs');
  const b = budget(o.limits);
  const fixtureBytes = read(o.fixture, b); assertDigest(sha(fixtureBytes), o.fixtureSha256, 'fixture');
  const fixture = JSON.parse(utf8(fixtureBytes)); const corpora = validateFixture(fixture, o.expectedCases);
  fs.mkdirSync(path.dirname(o.out), { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(path.dirname(o.out), '.freeze-'));
  try {
    const inventory = [];
    const save = (input, target, expected, meta = {}) => {
      const bytes = read(input, b); if (expected) assertDigest(sha(bytes), expected, target);
      write(path.join(stage, target), bytes, b);
      const row = { ...record(target, bytes), originalPath: input, ...meta }; inventory.push(row);
      return JSON.parse(utf8(bytes));
    };
    write(path.join(stage, 'fixture.json'), fixtureBytes, b);
    inventory.push(record('fixture.json', fixtureBytes));
    const execution = save(path.join(o.rankingRoot, 'execution-manifest-v2.json'), 'historical/ranking/execution-manifest-v2.json');
    need(execution.fixtureSha256 === o.fixtureSha256 && execution.hashes && typeof execution.hashes === 'object',
      'PROVENANCE', 'Historical execution fixture identity mismatch');
    const results = save(path.join(o.rankingRoot, 'results-manifest.json'), 'historical/ranking/results-manifest.json');
    const expectedOld = file => execution.hashes[path.join(execution.oldRoot || o.evidenceRoot, file)];
    const sourceManifest = save(path.join(o.evidenceRoot, 'sources.json'), 'sources.json', expectedOld('sources.json'));
    const chunkManifest = save(path.join(o.evidenceRoot, 'chunk-manifest.json'), 'chunk-manifest.json', expectedOld('chunk-manifest.json'));
    const oldManifest = save(path.join(o.evidenceRoot, 'manifest.json'), 'historical/old/manifest.json', expectedOld('manifest.json'));
    const sourcePin = oldManifest.artifacts?.find(x => x.path === 'sources.json');
    need(sourcePin, 'INCOMPLETE', 'No retained source manifest hash');
    assertDigest(inventory.find(x => x.path === 'sources.json').sha256, sourcePin.sha256, 'sources.json');
    need(sourceManifest.schemaVersion === 1 && Array.isArray(sourceManifest.corpora), 'INCOMPLETE', 'Missing source corpora');
    const sources = new Map(), rootMappings = [];
    for (const corpus of sourceManifest.corpora) {
      need(corpora.has(corpus.id) && corpus.snapshotRoot === corpora.get(corpus.id).root &&
        Array.isArray(corpus.files) && corpus.files.length > 0, 'PROVENANCE', 'Source corpus/root mismatch');
      relative(corpus.snapshotRoot);
      rootMappings.push({ corpus: corpus.id, fixtureRoot: corpora.get(corpus.id).root,
        originalRoot: corpus.originalRoot, retainedRoot: path.join(o.evidenceRoot, corpus.snapshotRoot),
        frozenRoot: corpus.snapshotRoot, searchVirtualRoot: `/__gmax_eval_frozen__/sources/${corpus.id}`,
        revision: corpus.revision });
      for (const f of corpus.files) {
        relative(f.path); const key = `${corpus.id}/${f.path}`;
        need(!sources.has(key) && hash(f.sha256), 'INCOMPLETE', 'Duplicate source or missing source hash');
        const file = path.join(o.evidenceRoot, corpus.snapshotRoot, f.path);
        const bytes = read(file, b, b.cap.sourceBytes);
        assertDigest(sha(bytes), f.sha256, key);
        need(bytes.length === f.bytes, 'HASH_MISMATCH', 'Source byte count mismatch');
        const text = utf8(bytes); need(!text.includes('\0'), 'SOURCE', 'Binary source refused');
        const row = { corpus: corpus.id, file: f.path, sha256: f.sha256, bytes: bytes.length,
          lineCount: text.split('\n').length, gitBlob: f.gitBlob, role: f.role };
        sources.set(key, row);
        write(path.join(stage, corpus.snapshotRoot, f.path), bytes, b);
      }
    }
    need(rootMappings.length === corpora.size && new Set(rootMappings.map(x => x.corpus)).size === corpora.size,
      'INCOMPLETE', 'Missing source corpus');
    const answers = [];
    for (const c of fixture.cases) for (const target of c.expected) {
      const s = sources.get(`${c.corpus}/${target.file}`);
      need(s, 'INCOMPLETE', 'Answer source absent'); assertDigest(s.sha256, target.sourceSha256, c.id);
      need(target.endLine <= s.lineCount, 'ANSWER_BOUNDS', `Answer outside source: ${c.id}`);
      answers.push({ caseId: c.id, corpus: c.corpus, ...target, lineCount: s.lineCount, coveringChunkIds: [] });
    }
    need(Array.isArray(chunkManifest.files) && chunkManifest.totalChunks > 0, 'INCOMPLETE', 'Missing chunk manifest');
    const chunkFiles = new Map(chunkManifest.files.map(f => [`${f.corpus}/${f.file}`, f]));
    need(chunkFiles.size === chunkManifest.files.length, 'DUPLICATE', 'Duplicate chunk manifest files');
    const chunkIds = [], chunkSet = new Set(), chunkCounts = new Map();
    const chunks = await scan(path.join(o.evidenceRoot, 'chunks.jsonl'), b, row => {
      const key = `${row.corpus}/${row.file}`, source = sources.get(key), declared = chunkFiles.get(key);
      need(source && declared && typeof row.id === 'string' && hash(row.id) && !chunkSet.has(row.id),
        'INCOMPLETE', 'Chunk source/id missing or duplicate');
      need(row.path === path.join(execution.oldRoot || o.evidenceRoot, corpora.get(row.corpus).root, row.file),
        'PROVENANCE', 'Prepared chunk path/root mismatch');
      assertDigest(row.sourceSha256, source.sha256, 'chunk source');
      assertDigest(declared.sourceSha256, source.sha256, 'chunk manifest source');
      need(typeof row.content === 'string', 'INCOMPLETE', 'Missing prepared text');
      assertDigest(sha(row.content), row.contentSha256, 'prepared chunk text');
      need(Number.isSafeInteger(row.start_line) && row.start_line >= 0 && Number.isSafeInteger(row.end_line) &&
        row.end_line >= row.start_line && row.end_line < source.lineCount, 'CHUNK_BOUNDS', 'Chunk outside source');
      chunkIds.push(row.id); chunkSet.add(row.id); chunkCounts.set(key, (chunkCounts.get(key) || 0) + 1);
      for (const a of answers) if (a.corpus === row.corpus && a.file === row.file && !row.is_anchor &&
        row.start_line + 1 <= a.startLine && row.end_line + 1 >= a.endLine) a.coveringChunkIds.push(row.id);
    }, path.join(stage, 'chunks.jsonl'));
    assertDigest(chunks.sha256, chunkManifest.sha256, 'chunks');
    if (expectedOld('chunks.jsonl')) assertDigest(chunks.sha256, expectedOld('chunks.jsonl'), 'historical chunks');
    need(chunks.rows === chunkManifest.totalChunks && chunks.bytes === chunkManifest.bytes &&
      [...chunkFiles].every(([key, f]) => chunkCounts.get(key) === f.chunks), 'INCOMPLETE', 'Incomplete chunk corpus');
    need(answers.every(x => x.coveringChunkIds.length > 0), 'INCOMPLETE', 'A full answer has no non-anchor covering chunk');
    inventory.push({ path: 'chunks.jsonl', ...chunks, state: 'frozen' });
    const fm = save(path.join(o.evidenceRoot, 'colbert-features-manifest.json'), 'historical/old/colbert-features-manifest.json', expectedOld('colbert-features-manifest.json'));
    assertDigest(fm.chunkSha256, chunks.sha256, 'feature chunk identity');
    const featurePath = path.join(o.evidenceRoot, 'colbert-features.jsonl');
    const features = await scan(featurePath, b, (row, i) => {
      need(row.id === chunkIds[i] && typeof row.colbert === 'string' && row.colbert.length > 0 &&
        Number.isFinite(row.scale) && row.scale > 0 && Array.isArray(row.pooled) && row.pooled.length === 48 &&
        row.pooled.every(Number.isFinite) && Array.isArray(row.tokenIds) && row.tokenIds.length > 0 &&
        row.tokenIds.every(n => Number.isSafeInteger(n) && n >= 0) &&
        Buffer.from(row.colbert, 'base64').length === row.tokenIds.length * 48,
      'INCOMPLETE', 'Historical feature order/shape mismatch');
    }, o.copyLargeEvidence ? path.join(stage, 'historical/old/colbert-features.jsonl') : undefined);
    assertDigest(features.sha256, fm.sha256, 'historical features');
    need(features.rows === chunks.rows && fm.chunks === chunks.rows, 'INCOMPLETE', 'Incomplete historical features');
    inventory.push({ path: o.copyLargeEvidence ? 'historical/old/colbert-features.jsonl' : null,
      originalPath: featurePath, ...features, state: o.copyLargeEvidence ? 'frozen' : 'verified-local-reference',
      provenance: provenance('historical', 'document-colbert-features', { model: fm.model }),
      portable: o.copyLargeEvidence });
    const historical = [];
    for (const candidate of ['small', 'gemma']) for (const rep of [1, 2]) {
      const prefix = `pass-${candidate}-${rep}`;
      const report = save(path.join(o.rankingRoot, `${prefix}.json`), `historical/ranking/${prefix}.json`, results.artifacts?.[`${prefix}.json`]);
      need(report.ok === true && report.candidate === candidate && report.repetition === rep &&
        Array.isArray(report.samples) && report.samples.length === fixture.cases.length * 2 &&
        report.manifestSha256 === inventory.find(x => x.path.endsWith('ranking/execution-manifest-v2.json')).sha256,
      'INCOMPLETE', 'Incomplete historical pass');
      const groups = [...corpora.keys()].map(corpus => fixture.cases.filter(c => c.corpus === corpus));
      const ids = Array.from({ length: Math.max(...groups.map(g => g.length)) }, (_, i) =>
        groups.map(g => g[i]?.id).filter(Boolean)).flat();
      const seen = new Set();
      const queries = await scan(path.join(o.rankingRoot, `${prefix}.queries.jsonl`), b, (row, i) => {
        need(row.id === ids[i] && row.generation === report.generation &&
          row.embedding?.generation === report.generation && row.embedding?.ids?.length === 1 &&
          row.embedding.ids[0] === row.id && Array.isArray(row.embedding.vectors) && row.embedding.vectors.length === 1 &&
          row.embedding.vectors[0].length === report.contract.dimensions && row.embedding.vectors[0].every(Number.isFinite) &&
          row.features && Array.isArray(row.features.colbert) && row.features.colbert.length > 0 &&
          row.features.colbert.every(v => Array.isArray(v) && v.length === 48 && v.every(Number.isFinite)),
        'INCOMPLETE', 'Historical query order/generation/shape mismatch');
      }, path.join(stage, `historical/ranking/${prefix}.queries.jsonl`));
      const rankings = await scan(path.join(o.rankingRoot, `${prefix}.rankings.jsonl`), b, (row, index) => {
        const key = `${row.id}/${row.variant}`;
        const variants = rep === 1 ? ['baseline', 'fixed'] : ['fixed', 'baseline'];
        need(row.id === ids[Math.floor(index / 2)] && row.variant === variants[index % 2] && !seen.has(key) &&
          Array.isArray(row.response?.data) && row.response?.diagnostics?.schemaVersion === 1,
        'INCOMPLETE', 'Historical rankings missing/duplicate diagnostics'); seen.add(key);
      }, path.join(stage, `historical/ranking/${prefix}.rankings.jsonl`));
      for (const [suffix, value] of [['queries.jsonl', queries], ['rankings.jsonl', rankings]]) {
        assertDigest(value.sha256, results.artifacts?.[`${prefix}.${suffix}`], prefix);
        assertDigest(value.sha256, report.outputHashes?.[`${prefix}.${suffix}`], 'pass output');
        inventory.push({ path: `historical/ranking/${prefix}.${suffix}`, ...value, state: 'frozen' });
      }
      need(queries.rows === ids.length && rankings.rows === ids.length * 2, 'INCOMPLETE', 'Historical case coverage incomplete');
      historical.push(provenance('historical', 'query-vectors-and-searcher-results', {
        candidate, repetition: rep, contract: report.contract, generation: report.generation,
        sourceExecutionManifest: 'historical/ranking/execution-manifest-v2.json',
        queryOrder: ids, scorer: { primary: 'complete answer span in exact file',
          retainedOriginalSource: 'historical/ranking/report-source-original.ts',
          expectedSha256: results.artifacts?.['report-source-original.ts'] },
        queryCache: `historical/ranking/${prefix}.queries.jsonl`, rankingCache: `historical/ranking/${prefix}.rankings.jsonl`,
        candidatePoolStatus: 'Historical final results and bounded diagnostic traces; not current-release rerank input lists.' }));
    }
    // Exact retained evaluator/scorer snapshots. Do not import or execute them.
    for (const file of ['driver-source-original.ts', 'report-source-original.ts', 'baseline-searcher.ts',
      'protocol-v2.json', 'candidate-evidence-v3.json', 'independent-review-opus-v2.json',
      'paired-report-v2.json', 'final-analysis.json', 'validation-final.json']) {
      const raw = read(path.join(o.rankingRoot, file), b);
      assertDigest(sha(raw), results.artifacts?.[file], file);
      write(path.join(stage, 'historical/ranking', file), raw, b);
      inventory.push(record(`historical/ranking/${file}`, raw));
    }
    // Retained old outputs/preparation metadata, without touching their native stores or model artifacts.
    for (const file of ['colbert-artifact.json', 'execution-manifest-v4.json', 'heldout-v2.json',
      'freeze-sources.py', 'freeze-chunks.ts', 'settings.json', 'granite-common-small-01.json',
      'granite-common-standard-01.json', 'granite-control-small-01.json', 'granite-control-standard-01.json',
      ...['small', 'standard', 'gemma'].flatMap(c => [1, 2].flatMap(n => [`pass-${c}-${n}.json`, `pass-${c}-${n}.rankings.jsonl`]))]) {
      const input = path.join(o.evidenceRoot, file);
      if (!fs.existsSync(input)) { inventory.push({ path: null, originalPath: input, state: 'missing', provenance: 'historical' }); continue; }
      if (file.endsWith('.jsonl')) {
        const stats = await scan(input, b, () => {}, path.join(stage, 'historical/old', file));
        if (expectedOld(file)) assertDigest(stats.sha256, expectedOld(file), file);
        inventory.push({ path: `historical/old/${file}`, ...stats, state: 'frozen', provenance: 'historical' });
      } else {
        const raw = read(input, b); if (expectedOld(file)) assertDigest(sha(raw), expectedOld(file), file);
        write(path.join(stage, 'historical/old', file), raw, b);
        inventory.push({ ...record(`historical/old/${file}`, raw), provenance: 'historical',
          hashAuthority: expectedOld(file) ? 'retained-execution-manifest' : 'observed-local-bytes' });
      }
    }
    const historicalSources = [];
    const retainedRepo = path.resolve(execution.oldRoot || o.evidenceRoot, '../../..');
    // Only source files named by the retained execution are inspected. Store paths
    // and artifact/runtime paths in that larger manifest are deliberately ignored.
    const namedSources = Object.entries(execution.hashes).filter(([file]) =>
      file.startsWith(retainedRepo + '/scripts/') || file.startsWith(retainedRepo + '/src/'));
    for (const [originalPath, expectedSha256] of namedSources) {
      const relativePath = path.relative(retainedRepo, originalPath).split(path.sep).join('/');
      relative(relativePath);
      const localPath = path.join(o.repoRoot, relativePath);
      if (!fs.existsSync(localPath)) {
        historicalSources.push({ path: relativePath, expectedSha256, state: 'missing', provenance: 'historical' });
        continue;
      }
      const raw = read(localPath, b), observedSha256 = sha(raw), matches = observedSha256 === expectedSha256;
      if (matches) write(path.join(stage, 'historical/source', relativePath), raw, b);
      historicalSources.push({ path: relativePath, expectedSha256, observedSha256,
        state: matches ? 'frozen' : 'changed-local-source-not-copied', provenance: 'historical',
        frozenPath: matches ? `historical/source/${relativePath}` : null });
    }
    let upstream = { state: 'missing', reason: 'Parent-owned upstream metadata not supplied.' };
    if (o.upstreamMetadata) {
      const raw = read(o.upstreamMetadata, b), metadata = JSON.parse(utf8(raw));
      need(metadata.schemaVersion === 1 && /^[a-f0-9]{40}$/.test(metadata.revision) &&
        metadata.inferencePerformed === false && metadata.weightsDownloaded === false &&
        hash(metadata.backbone?.expectedSha256) && Array.isArray(metadata.projection?.orderedArtifacts),
      'PROVENANCE', 'Invalid upstream metadata');
      assertDigest(sha(JSON.stringify(metadata.projection.orderedArtifacts)),
        metadata.projection.expectedAggregateSha256, 'projection metadata aggregate');
      write(path.join(stage, 'upstream-mixedbread.json'), raw, b);
      upstream = { state: 'metadata-only', metadata: record('upstream-mixedbread.json', raw),
        modelId: metadata.modelId, revision: metadata.revision,
        expectedBackboneSha256: metadata.backbone.expectedSha256,
        expectedProjectionAggregateSha256: metadata.projection.expectedAggregateSha256,
        originalWeightBytesLocallyVerified: false, knownPreparationDifferences: metadata.knownPreparationDifferences,
        semanticParity: 'unverified; later real tokenizer/runtime validation required' };
    }
    const localArtifacts = [];
    for (const [key, expected, size] of [
      ['onnxWeights', fm.model?.files?.find(f => f.path === 'onnx/model_int8.onnx')?.sha256,
        fm.model?.files?.find(f => f.path === 'onnx/model_int8.onnx')?.bytes],
      ['onnxTokenizer', fm.model?.files?.find(f => f.path === 'tokenizer.json')?.sha256,
        fm.model?.files?.find(f => f.path === 'tokenizer.json')?.bytes]]) {
      if (!o[key]) continue;
      // Hash bytes only. Never instantiate a runtime or copy model bytes.
      const input = o[key], stat = regular(input); b.file();
      need(stat.size <= b.cap.fileBytes, 'FILE_LIMIT', 'Local artifact byte cap exceeded');
      const fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const digest = crypto.createHash('sha256'), block = Buffer.alloc(64 * 1024); let bytes = 0;
      try {
        for (let n; (n = fs.readSync(fd, block, 0, block.length, null)) > 0;) {
          bytes += n; b.read(n); need(bytes <= b.cap.fileBytes, 'FILE_LIMIT', 'Growing local artifact');
          digest.update(block.subarray(0, n));
        }
        need(fs.fstatSync(fd).mtimeMs === stat.mtimeMs && bytes === stat.size, 'CHANGED', 'Local artifact changed');
      } finally { fs.closeSync(fd); }
      const digestHex = digest.digest('hex'); assertDigest(digestHex, expected, key);
      need(bytes === size, 'HASH_MISMATCH', 'Local artifact size mismatch');
      localArtifacts.push({ kind: key, state: 'verified-local-reference', originalPath: path.resolve(input),
        sha256: digestHex, bytes, copied: false, provenance: 'local bytes match retained ONNX artifact metadata',
        inferencePerformed: false, semanticParity: 'unverified' });
    }
    const release = releaseIdentity(o, stage, b);
    const missing = [
      { id: 'current-release-granite-document-vectors', state: 'blocked', reason: 'No standalone current-release dense document export; native stores are outside Wave 1 access.' },
      { id: 'current-release-granite-query-vectors', state: 'blocked', reason: 'Available 30-case Granite query vectors are historical MLX BF16 experiment outputs.' },
      { id: 'current-release-rerank-candidate-pools', state: 'blocked', reason: 'No frozen current-release exact ordered rerank inputs, lexical lists, structure weights, gate decisions and symbol additions for these 30 cases.' },
      { id: 'current-release-model-artifact-identity', state: 'missing', reason: 'Optional local ONNX hashes are reported separately. Current-release Granite artifact chain and original Mixedbread backbone/projection bytes plus runtime equivalence remain unqualified; upstream LFS digests are expectations only.' },
    ];
    if (release.archive.state !== 'verified-local-reference') missing.push({ id: 'accepted-release-archive-bytes', state: 'missing', reason: 'Local acceptance receipt has hash only; supply the already accepted archive, without downloading in Wave 1.' });
    if (release.source.state === 'missing') missing.push({ id: 'accepted-release-source-identity', state: 'missing', reason: release.source.reason });
    const manifest = { schemaVersion: 1, component: 'colbert-wave1-freezer',
      status: 'incomplete', sourcePreparation: 'verified', currentReleasePreparation: 'blocked',
      inferencePerformed: false, modelImported: false, storesAccessed: false,
      fixture: { ...record('fixture.json', fixtureBytes), cases: fixture.cases.length,
        exposure: 'Previously reviewed and exposed regression set; not a blind holdout.',
        questionsSha256: sha(stable(fixture.cases.map(c => ({ id: c.id, query: c.query })))) },
      counts: { sourceFiles: sources.size, preparedChunks: chunks.rows, answerSpans: answers.length,
        verifiedAnswerSpans: answers.filter(x => x.coveringChunkIds.length).length },
      rootMappings, sources: [...sources.values()], answers, release, upstream, localArtifacts, historical, historicalSources, inventory,
      evidencePolicy: { historicalCachesAreCurrentReleaseCandidates: false,
        largeFeatureBytesCopied: o.copyLargeEvidence, sourceLabelsRebased: false,
        excluded: ['native stores/indexes', 'raw model weights', 'production configuration and private unrelated files'] },
      missing, nextGate: 'Before inference: obtain the accepted local release archive and prove evaluator source/lock/scorer equivalence; under a separately authorized runtime gate, verify immutable deployed model artifacts and export Granite document/query vectors plus exact ordered released-Searcher rerank inputs for all 30 fixed cases in a fresh isolated store. Preserve lexical candidates, structure weights, gate decisions and symbol additions. Historical caches cannot satisfy this gate.',
      limits: b.cap, io: b.stats() };
    write(path.join(stage, 'result-manifest.json'), stable(manifest), b);
    need(!fs.existsSync(o.out), 'OUTPUT_EXISTS', 'Output appeared during preparation');
    fs.renameSync(stage, o.out);
    return { manifestPath: path.join(o.out, 'result-manifest.json'), manifestSha256: sha(stable(manifest)),
      status: manifest.status, sourcePreparation: manifest.sourcePreparation, currentReleasePreparation: manifest.currentReleasePreparation,
      counts: manifest.counts, missing: missing.map(x => x.id), inferencePerformed: false };
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
}
const HELP = `Usage: node scripts/colbert-eval/freeze.cjs --fixture PATH --evidence-root PATH --ranking-root PATH --out NEW_DIR [options]

Local-only Wave 1 freezer (Node stdlib). No models, inference, stores, network or installs.
Required roots are retained October 21 source/chunk and ranking experiment roots.
--fixture-sha256 HEX  Expected fixture SHA256 (default accepted 30-case checksum)
--cases N              Expected unique cases (default 30; max 256)
--copy-large-evidence  Copy the 337 MB historical feature cache; default hashes and
                       validates every row, records a nonportable local reference.
--repo-root PATH       Local git repository (default cwd)
--release-ref vX.Y.Z    Read exact source/lock from an existing local version tag
--release-receipt PATH Existing accepted JSON {version,sha256} archive receipt
--release-archive PATH Existing archive; hash against receipt, reference without copying
--upstream-metadata PATH Parent-owned pinned upstream metadata; expected weights remain unverified
--onnx-weights PATH     Hash-only local ONNX weights against retained artifact manifest
--onnx-tokenizer PATH   Hash-only local ONNX tokenizer against retained artifact manifest
--help                 Show this help

Output is a private fresh directory, published only after all source/answer/chunk
and required historical-cache checks pass. Invalid/missing required evidence exits
1 and removes staging. Authentic but incomplete current-release preparation emits
result-manifest.json and exits 2. Exit 0 is reserved for help; this Wave 1 freezer
cannot establish current-release readiness. JSON result on stdout, bounded errors
on stderr. Hashes are exact bytes; questions use JSON pretty-print + LF, ordered
by fixture. Source paths/labels/text are never rewritten. Limits: 512 MiB/file,
16 MiB/metadata, 2 MiB/source and JSONL line, 1.5 GiB total reads, 768 MiB output,
100000 JSONL rows/file, 1800 files. Sources must be regular UTF-8 files, no symlinks.
Only --release-ref invokes a read-only git subprocess (10s/4 MiB command limits).
No completeness or runtime qualification is implied by a successful source freeze.
`;
function args(argv) {
  const o = {}, flags = { '--fixture': 'fixture', '--evidence-root': 'evidenceRoot', '--ranking-root': 'rankingRoot',
    '--out': 'out', '--fixture-sha256': 'fixtureSha256', '--cases': 'expectedCases', '--repo-root': 'repoRoot',
    '--release-ref': 'releaseRef', '--release-receipt': 'releaseReceipt', '--release-archive': 'releaseArchive',
    '--upstream-metadata': 'upstreamMetadata', '--onnx-weights': 'onnxWeights', '--onnx-tokenizer': 'onnxTokenizer' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help') return { help: true };
    if (flag === '--copy-large-evidence') { need(!o.copyLargeEvidence, 'ARGS', 'Duplicate flag'); o.copyLargeEvidence = true; continue; }
    need(flags[flag] && i + 1 < argv.length && !argv[i + 1].startsWith('--') && !(flags[flag] in o), 'ARGS', 'Unknown, duplicate or incomplete argument');
    o[flags[flag]] = argv[++i];
  }
  if ('expectedCases' in o) o.expectedCases = Number(o.expectedCases);
  return o;
}
if (require.main === module) {
  (async () => {
    const o = args(process.argv.slice(2));
    if (o.help) { process.stdout.write(HELP); return; }
    const result = await freeze(o); process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = 2;
  })().catch(e => { process.stderr.write(JSON.stringify({ ok: false, code: e.code || 'INVALID_EVIDENCE',
    message: String(e.message).replace(/[\r\n]/g, ' ').slice(0, 400), inferencePerformed: false }) + '\n'); process.exitCode = 1; });
}
module.exports = { FIXTURE_SHA256, LIMITS, freeze, validateFixture, provenance, scan, budget, args, sha };
