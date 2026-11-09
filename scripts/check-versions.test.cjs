const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const check = require('./check-versions.cjs');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = ms => new Date(NOW - ms).toISOString();

const ENGINE_FILES = {
  'scripts/prepare-bounded-runtime.cjs': v => `if (manifest.schemaVersion !== 1 || manifest.engine !== "${v}") throw 1;\n`,
  'scripts/assemble-bounded-runtime.cjs': v => `const manifest = {engine: "${v}"};\nif (capability.engine !== "${v}") throw 1;\n`,
  'lance-maintenance/native/src/main.rs': v => `json!({"protocolVersion":1,"engine":"${v}"})\n`,
  'lance-maintenance/native/src/engine.rs': v => `json!({"protocolVersion":2,"engine":"${v}"})\n`,
  'lance-maintenance/pyproject.toml': v => `dependencies = ["pylance==${v}"]\n`,
  'lance-maintenance/maintain.py': v => `ENGINE = "${v}"\n`,
  'lance-maintenance/prune.py': v => `if importlib.metadata.version("pylance") != "${v}":\n    pass\nx = {"engine": "${v}"}\n`,
  'lance-maintenance/fts.py': v => `if importlib.metadata.version("pylance") != "${v}":\n    pass\n`,
  'scripts/compact-recovery.py': v => `if importlib.metadata.version('pylance') != '${v}':\n    pass\n`,
};

const UV_LOCK = `version = 1
requires-python = ">=3.10"
resolution-markers = [
    "python_full_version >= '3.12'",
    "python_full_version == '3.11.*'",
    "python_full_version < '3.11'",
]

[[package]]
name = "fixture"
version = "0.1.0"
source = { virtual = "." }
dependencies = [
    { name = "numpy" },
]

[package.metadata]
requires-dist = [{ name = "numpy" }]

[[package]]
name = "numpy"
version = "2.2.6"
source = { registry = "https://pypi.org/simple" }
resolution-markers = [
    "python_full_version < '3.11'",
]
sdist = { url = "https://example.invalid/numpy-2.2.6.tar.gz" }

[[package]]
name = "numpy"
version = "2.5.4"
source = { registry = "https://pypi.org/simple" }
resolution-markers = [
    "python_full_version >= '3.12'",
    "python_full_version == '3.11.*'",
]
dependencies = [
    { name = "six", marker = "python_full_version >= '3.11'" },
]

[[package]]
name = "six"
version = "1.17.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "vlm"
version = "0.7.4"
source = { git = "https://github.com/example/vlm.git?rev=${'a'.repeat(40)}#${'a'.repeat(40)}" }
`;

// A gmax-shaped tree whose every dependency is current against `registry()`.
function fixture(t, { engine = '14.0.2' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grepmax-versions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  write('package.json', JSON.stringify({
    dependencies: { '@huggingface/transformers': '^4.3.2', 'onnxruntime-node': '1.30.0', vite: '^8.3.6' },
    devDependencies: { '@lancedb/lancedb': '0.41.0', 'sdk-v1-fixture': 'npm:@example/sdk@1.32.2' },
    optionalDependencies: { '@lancedb/lancedb-linux-x64-gnu': '0.41.0' },
  }));
  write('pnpm-workspace.yaml', [
    'overrides:', '  mathjs: "15.2.0"', '',
    '# a comment', 'minimumReleaseAgeExclude:', '  - "@lancedb/lancedb-linux-x64-gnu@0.41.0"', '  # Explicit pin', '  - "@example/*"', '',
  ].join('\n'));
  write('pnpm-lock.yaml', `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@huggingface/transformers':
        specifier: ^4.3.2
        version: 4.3.2(@types/node@26.6.6)
      onnxruntime-node:
        specifier: 1.30.0
        version: 1.30.0
      vite:
        specifier: ^8.3.6
        version: 8.3.6(@types/node@26.6.6)
    devDependencies:
      '@lancedb/lancedb':
        specifier: 0.41.0
        version: 0.41.0
      sdk-v1-fixture:
        specifier: npm:@example/sdk@1.32.2
        version: '@example/sdk@1.32.2(zod@4.6.7)'
    optionalDependencies:
      '@lancedb/lancedb-linux-x64-gnu':
        specifier: 0.41.0
        version: 0.41.0

packages:

  vite@8.3.6:
    resolution: {integrity: sha512-x}
`);
  write('lance-maintenance/native/Cargo.toml', `[package]
name = "fixture-helper"
version = "0.1.0"

[dependencies]
lance = { version = "=14.0.2", default-features = false, optional = true }
arrow-array = { version = "58", optional = true }
tokio = { version = "1", features = ["rt"] }
anyhow = "1"

[features]
engine = ["dep:lance"]

[dev-dependencies]
tempfile = "3"
`);
  write('lance-maintenance/native/Cargo.lock', `version = 4

[[package]]
name = "anyhow"
version = "1.0.100"

[[package]]
name = "arrow-array"
version = "57.0.0"

[[package]]
name = "arrow-array"
version = "58.4.1"

[[package]]
name = "fixture-helper"
version = "0.1.0"
dependencies = [
 "anyhow",
 "arrow-array 58.4.1",
 "lance",
 "tempfile",
 "tokio",
]

[[package]]
name = "lance"
version = "14.0.2"
dependencies = [
 "arrow-array 58.4.1",
]

[[package]]
name = "tempfile"
version = "3.23.0"

[[package]]
name = "tokio"
version = "1.48.0"
`);
  for (const [file, text] of Object.entries(ENGINE_FILES)) write(file, text(engine));
  write('lance-maintenance/uv.lock', UV_LOCK);
  return { root, write };
}

function npmEntry(versions, { latest = Object.keys(versions).at(-1), dependencies = {} } = {}) {
  return {
    'dist-tags': { latest },
    versions: Object.fromEntries(Object.keys(versions).map(version => [version, { dependencies: dependencies[version] ?? {} }])),
    time: { created: ago(900 * DAY), modified: ago(0), ...versions },
  };
}

// crates.io's crate document: max_stable_version and every published version.
function crateEntry(versions, { yanked = [] } = {}) {
  const stable = versions.filter(version => !version.includes('-') && !yanked.includes(version));
  return { crate: { max_stable_version: stable.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1) },
    versions: versions.map(num => ({ num, yanked: yanked.includes(num) })) };
}

function pypiEntry(releases) {
  return { releases: Object.fromEntries(Object.entries(releases).map(([version, file]) => [version, [{ yanked: false, requires_python: null, ...file }]])) };
}

// Every registry answer the fixture needs, all current.
function registry() {
  return {
    'https://registry.npmjs.org/@huggingface%2Ftransformers': npmEntry({ '4.3.1': ago(30 * DAY), '4.3.2': ago(10 * DAY) },
      { dependencies: { '4.3.2': { 'onnxruntime-node': '1.30.0' } } }),
    'https://registry.npmjs.org/onnxruntime-node': npmEntry({ '1.30.0': ago(20 * DAY), '1.31.0': ago(5 * DAY) }),
    // 8.3.7 is 3 hours old, inside pnpm's 1 day release age, so 8.3.6 is latest.
    'https://registry.npmjs.org/vite': npmEntry({ '8.3.6': ago(4 * DAY), '8.3.7': ago(3 * 60 * 60 * 1000), '9.0.0-beta.1': ago(2 * DAY) }, { latest: '8.3.7' }),
    'https://registry.npmjs.org/@lancedb%2Flancedb': npmEntry({ '0.40.0': ago(40 * DAY), '0.41.0': ago(9 * DAY) }),
    // Younger than the release age, but minimumReleaseAgeExclude names this version.
    'https://registry.npmjs.org/@lancedb%2Flancedb-linux-x64-gnu': npmEntry({ '0.40.0': ago(40 * DAY), '0.41.0': ago(60 * 1000) }),
    'https://registry.npmjs.org/@example%2Fsdk': npmEntry({ '1.32.2': ago(1000) }),
    'https://crates.io/api/v1/crates/lancedb/0.41.0/dependencies': { dependencies: [
      { crate_id: 'lance', req: '=14.0.2', kind: 'normal' }, { crate_id: 'lance-testing', req: '=14.0.2', kind: 'dev' }] },
    'https://crates.io/api/v1/crates/lance': { crate: { max_stable_version: '14.0.2', max_version: '15.0.0-beta.3' } },
    'https://crates.io/api/v1/crates/lance/14.0.2/dependencies': { dependencies: [
      { crate_id: 'arrow-array', req: '^58.0.0', kind: 'normal' }, { crate_id: 'tempfile', req: '^3', kind: 'dev' }] },
    'https://crates.io/api/v1/crates/arrow-array': crateEntry(['57.0.0', '58.4.1']),
    'https://crates.io/api/v1/crates/tokio': { crate: { max_stable_version: '1.48.0' } },
    'https://crates.io/api/v1/crates/anyhow': { crate: { max_stable_version: '1.0.100' } },
    'https://crates.io/api/v1/crates/tempfile': { crate: { max_stable_version: '3.23.0' } },
    'https://pypi.org/pypi/numpy/json': pypiEntry({
      '2.2.5': {}, '2.2.6': { requires_python: '>=3.10' }, '2.4.6': { requires_python: '>=3.11' }, '2.5.4': { requires_python: '>=3.12' },
      '2.6.0rc1': { requires_python: '>=3.12' }, '2.5.5': { yanked: true } }),
    'https://pypi.org/pypi/six/json': pypiEntry({ '1.16.0': {}, '1.17.0': { requires_python: '!=3.0.*,!=3.1.*,>=2.7' } }),
    'https://pypi.org/pypi/numpy/2.5.4/json': { info: { requires_dist: ["six; python_full_version >= '3.11'", "six<1.17; extra == 'dev'"] } },
  };
}

function options(t, { answers = registry(), heads = { 'https://github.com/example/vlm.git': 'a'.repeat(40) }, ...rest } = {}) {
  const { root, write } = fixture(t, rest);
  const fetched = [];
  const fetchJson = async url => {
    fetched.push(url);
    if (!(url in answers)) throw new Error('HTTP 404');
    return structuredClone(answers[url]);
  };
  const gitHead = remote => { if (!heads[remote]) throw new Error(`could not read ${remote}`); return heads[remote]; };
  return { root, write, answers, heads, fetched, run: () => check.checkVersions({ root, fetchJson, gitHead, now: NOW, delay: async () => {}, uvLocks: ['lance-maintenance/uv.lock'] }) };
}

test('a tree with every dependency current passes', async t => {
  const { run } = options(t);
  const result = await run();
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.counts, { npm: 6, rust: 5, python: 4 });
});

test('npm: a lagging package prints its locked and latest versions', async t => {
  const { run, answers } = options(t);
  answers['https://registry.npmjs.org/vite'] = npmEntry({ '8.3.6': ago(4 * DAY), '8.3.7': ago(2 * DAY) });
  answers['https://registry.npmjs.org/@example%2Fsdk'] = npmEntry({ '1.32.2': ago(10 * DAY), '2.0.0': ago(2 * DAY) });
  assert.deepEqual((await run()).lines, ['npm vite 8.3.6, latest 8.3.7', 'npm sdk-v1-fixture (@example/sdk) 1.32.2, latest 2.0.0']);
});

test('npm: minimumReleaseAge from pnpm-workspace.yaml replaces the 1 day default', async t => {
  const { run, write, answers } = options(t);
  answers['https://registry.npmjs.org/vite'] = npmEntry({ '8.3.6': ago(4 * DAY), '8.3.7': ago(2 * DAY) });
  answers['https://registry.npmjs.org/@example%2Fsdk'] = npmEntry({ '1.32.2': ago(10 * DAY) });
  write('pnpm-workspace.yaml', 'minimumReleaseAge: 4320\n');
  const { lines } = await run();
  assert.equal(lines.some(line => line.startsWith('npm vite')), false);
  assert.ok(lines.includes('npm @lancedb/lancedb-linux-x64-gnu 0.41.0, latest 0.40.0'), lines.join('\n'));
  assert.equal(check.readWorkspace('overrides: {}\n').ageMinutes, check.PNPM_DEFAULT_RELEASE_AGE_MINUTES);
  assert.throws(() => check.readWorkspace('minimumReleaseAgeExclude:\n  - vite@^8.0.0\n'), /only exact versions are understood/);
});

test('npm: onnxruntime-node is held to the version the latest transformers depends on', async t => {
  const { run, answers } = options(t);
  answers['https://registry.npmjs.org/@huggingface%2Ftransformers'] = npmEntry({ '4.3.2': ago(10 * DAY), '4.4.0': ago(3 * DAY) },
    { dependencies: { '4.3.2': { 'onnxruntime-node': '1.30.0' }, '4.4.0': { 'onnxruntime-node': '1.31.0' } } });
  assert.deepEqual((await run()).lines, ['npm @huggingface/transformers 4.3.2, latest 4.4.0',
    'npm onnxruntime-node 1.30.0, held to 1.31.0 by @huggingface/transformers 4.4.0']);
  answers['https://registry.npmjs.org/@huggingface%2Ftransformers'].versions['4.4.0'].dependencies['onnxruntime-node'] = '^1.31.0';
  await assert.rejects(run(), { message: "Could not check npm onnxruntime-node: @huggingface/transformers 4.4.0 depends on '^1.31.0', not an exact version" });
});

test('rust: crates are judged against the latest stable, and lance against what LanceDB embeds', async t => {
  const { run, answers } = options(t);
  answers['https://crates.io/api/v1/crates/lance/14.0.2/dependencies'].dependencies[0].req = '>=58';
  answers['https://crates.io/api/v1/crates/arrow-array'] = crateEntry(['58.4.1', '60.1.0', '61.0.0-rc.1']);
  answers['https://crates.io/api/v1/crates/tempfile'] = { crate: { max_stable_version: '3.24.0' } };
  answers['https://crates.io/api/v1/crates/lancedb/0.41.0/dependencies'].dependencies[0].req = '=14.0.3';
  const result = await run();
  assert.deepEqual(result.lines, ['cargo lance 14.0.2, LanceDB 0.41.0 embeds Lance 14.0.3',
    'cargo arrow-array 58.4.1, latest 60.1.0', 'cargo tempfile 3.23.0, latest 3.24.0']);
  assert.deepEqual(result.held, []);
});

test('rust: lance follows LanceDB, not a newer Lance on crates.io', async t => {
  const { run, answers, write, root } = options(t);
  answers['https://crates.io/api/v1/crates/lance'] = { crate: { max_stable_version: '15.0.0' } };
  const current = await run();
  assert.deepEqual(current.lines, []);
  assert.deepEqual(current.held, ['cargo lance 14.0.2, held by LanceDB 0.41.0 (=14.0.2); latest 15.0.0']);
  const lock = fs.readFileSync(path.join(root, 'lance-maintenance/native/Cargo.lock'), 'utf8');
  write('lance-maintenance/native/Cargo.lock', lock.replace('name = "lance"\nversion = "14.0.2"', 'name = "lance"\nversion = "15.0.0"'));
  for (const [file, text] of Object.entries(ENGINE_FILES)) write(file, text('15.0.0'));
  answers['https://crates.io/api/v1/crates/lance/15.0.0/dependencies'] = answers['https://crates.io/api/v1/crates/lance/14.0.2/dependencies'];
  const ahead = await run();
  assert.deepEqual(ahead.lines, ['cargo lance 15.0.0, LanceDB 0.41.0 embeds Lance 14.0.2']);
  assert.deepEqual(ahead.held, []);
});

test('rust: a crate a parent holds below its latest is current at the newest release the parent admits', async t => {
  const { run, answers, fetched } = options(t);
  answers['https://crates.io/api/v1/crates/arrow-array'] = crateEntry(['57.0.0', '58.4.1', '58.4.2', '59.0.0', '60.1.0', '58.5.0-rc.1'], { yanked: ['58.4.2'] });
  const result = await run();
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.held, ['cargo arrow-array 58.4.1, held by lance 14.0.2 (^58.0.0); latest 60.1.0']);
  assert.ok(fetched.includes('https://crates.io/api/v1/crates/lance/14.0.2/dependencies'));
  answers['https://crates.io/api/v1/crates/arrow-array'] = crateEntry(['58.4.1', '58.5.0', '60.1.0']);
  assert.deepEqual((await run()).lines, ['cargo arrow-array 58.4.1, held to 58.5.0 by lance 14.0.2 (^58.0.0)']);
});

test('rust: every parent bounds the held version, and the loosest one is named', async t => {
  const { run, answers, write, root } = options(t);
  const lock = fs.readFileSync(path.join(root, 'lance-maintenance/native/Cargo.lock'), 'utf8');
  write('lance-maintenance/native/Cargo.lock', `${lock}
[[package]]
name = "arrow-ipc"
version = "58.4.1"
dependencies = [
 "arrow-array 58.4.1",
]
`);
  answers['https://crates.io/api/v1/crates/arrow-ipc/58.4.1/dependencies'] = { dependencies: [{ crate_id: 'arrow-array', req: '^58.4.1', kind: 'normal' }] };
  answers['https://crates.io/api/v1/crates/arrow-array'] = crateEntry(['58.0.0', '58.4.1', '60.1.0']);
  assert.deepEqual((await run()).held, ['cargo arrow-array 58.4.1, held by lance 14.0.2 (^58.0.0) and 1 other parent; latest 60.1.0']);
  answers['https://crates.io/api/v1/crates/arrow-ipc/58.4.1/dependencies'].dependencies[0].req = '~58.3';
  assert.deepEqual((await run()).lines, ['cargo arrow-array 58.4.1, held to no release by lance 14.0.2 (^58.0.0) and 1 other parent']);
});

test('rust: Cargo requirements', () => {
  const admits = (requirement, versions) => versions.filter(version => check.cargoAdmits(requirement, version));
  const versions = ['0.0.3', '0.0.4', '0.1.0', '0.2.5', '1.0.0', '1.2.0', '1.2.3', '1.2.9', '1.3.0', '2.0.0'];
  assert.deepEqual(admits('^1.2.3', versions), ['1.2.3', '1.2.9', '1.3.0']);
  assert.deepEqual(admits('1.2', versions), ['1.2.0', '1.2.3', '1.2.9', '1.3.0']);
  assert.deepEqual(admits('^0.2', versions), ['0.2.5']);
  assert.deepEqual(admits('^0.0.3', versions), ['0.0.3']);
  assert.deepEqual(admits('~1.2', versions), ['1.2.0', '1.2.3', '1.2.9']);
  assert.deepEqual(admits('=1.2', versions), ['1.2.0', '1.2.3', '1.2.9']);
  assert.deepEqual(admits('=1.2.3', versions), ['1.2.3']);
  assert.deepEqual(admits('1.*', versions), ['1.0.0', '1.2.0', '1.2.3', '1.2.9', '1.3.0']);
  assert.deepEqual(admits('>=1.2.3, <1.3', versions), ['1.2.3', '1.2.9']);
  assert.deepEqual(admits('>1.2', versions), ['1.3.0', '2.0.0']);
  assert.deepEqual(admits('<=1.2', versions), ['0.0.3', '0.0.4', '0.1.0', '0.2.5', '1.0.0', '1.2.0', '1.2.3', '1.2.9']);
  assert.deepEqual(admits('*', versions), versions);
  assert.throws(() => check.cargoAdmits('latest', '1.0.0'), /Could not read Cargo requirement 'latest'/);
});

test('rust: every engine string must name the Lance crate version', async t => {
  const { run, write } = options(t);
  write('scripts/prepare-bounded-runtime.cjs', ENGINE_FILES['scripts/prepare-bounded-runtime.cjs']('14.0.1'));
  write('lance-maintenance/native/src/main.rs', 'fn main() {}\n');
  write('lance-maintenance/prune.py', 'x = {"engine": "14.0.2"}\ny = {"engine": "13.0.0"}\n');
  assert.deepEqual((await run()).lines, [
    'engine scripts/prepare-bounded-runtime.cjs names 14.0.1, Lance crate 14.0.2',
    'engine lance-maintenance/native/src/main.rs no longer names the Lance engine in the form this check reads',
    'engine lance-maintenance/prune.py names 13.0.0, Lance crate 14.0.2',
  ]);
});

test('python: a lagging package and a moved git source are reported', async t => {
  const { run, answers, heads } = options(t);
  answers['https://pypi.org/pypi/six/json'] = pypiEntry({ '1.17.0': {}, '1.18.0': {}, '2.0.0b1': {}, '1.19.0': { yanked: true } });
  heads['https://github.com/example/vlm.git'] = 'b'.repeat(40);
  assert.deepEqual((await run()).lines, [
    'pypi lance-maintenance/uv.lock vlm git aaaaaaaaaaaa, upstream HEAD bbbbbbbbbbbb',
    'pypi lance-maintenance/uv.lock six 1.17.0, latest 1.18.0',
  ]);
});

test('python: a package a parent holds below its latest is current at the newest release the parent admits', async t => {
  const { run, answers } = options(t);
  answers['https://pypi.org/pypi/six/json'] = pypiEntry({ '1.16.0': {}, '1.17.0': {}, '1.18.0': {} });
  answers['https://pypi.org/pypi/numpy/2.5.4/json'].info.requires_dist = ['six[extra] (<=1.17.0,>=1.10)', 'six>=2; extra == "dev"'];
  const result = await run();
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.held, ['pypi lance-maintenance/uv.lock six 1.17.0, held by numpy 2.5.4 (<=1.17.0,>=1.10); latest 1.18.0']);
  answers['https://pypi.org/pypi/six/json'] = pypiEntry({ '1.17.0': {}, '1.17.1': {}, '1.18.0': {} });
  answers['https://pypi.org/pypi/numpy/2.5.4/json'].info.requires_dist = ['Six~=1.17.0'];
  assert.deepEqual((await run()).lines, ['pypi lance-maintenance/uv.lock six 1.17.0, held to 1.17.1 by numpy 2.5.4 (~=1.17.0)']);
});

test('python: requirement specifiers', () => {
  const admits = (specifiers, versions) => versions.filter(version => check.pep440Admits(specifiers, version));
  const versions = ['1.9', '2.0', '2.0.post1', '2.1.0', '2.4.6', '3.0'];
  assert.deepEqual(admits('>=2.0,<3', versions), ['2.0', '2.0.post1', '2.1.0', '2.4.6']);
  assert.deepEqual(admits('~=2.1', versions), ['2.1.0', '2.4.6']);
  assert.deepEqual(admits('==2.*', versions), ['2.0', '2.0.post1', '2.1.0', '2.4.6']);
  assert.deepEqual(admits('!=2.4.6,<=2.4.6', versions), ['1.9', '2.0', '2.0.post1', '2.1.0']);
  assert.deepEqual(check.requirementsOn(['fsspec[http]<=2026.7.0,>=2023.1.0', 'Fsspec>=1; extra == "s3"', 'other>=1'], 'fsspec'), ['<=2026.7.0,>=2023.1.0']);
  assert.throws(() => check.pep440Admits('>=latest', '1.0'), /Could not read Python requirement/);
});

test('python: a version split passes only when the Python version forces it', async t => {
  const { run, answers, write } = options(t);
  answers['https://pypi.org/pypi/numpy/json'].releases['2.3.0'] = [{ yanked: false, requires_python: '>=3.10' }];
  assert.deepEqual((await run()).lines, ['pypi lance-maintenance/uv.lock numpy 2.2.6 for Python 3.10, latest for that Python 2.3.0']);
  delete answers['https://pypi.org/pypi/numpy/json'].releases['2.3.0'];
  write('lance-maintenance/uv.lock', UV_LOCK.replace(`    "python_full_version < '3.11'",\n]\nsdist`, `    "sys_platform == 'win32'",\n]\nsdist`));
  assert.deepEqual((await run()).lines, ['pypi lance-maintenance/uv.lock numpy 2.2.6 is split on a marker other than the Python version']);
});

test('python: floors and requires-python clauses', () => {
  assert.equal(check.markerFloor(["python_full_version < '3.11'"], '3.10'), '3.10');
  assert.equal(check.markerFloor(["python_full_version >= '3.12'", "python_full_version == '3.11.*'"], '3.10'), '3.11');
  assert.equal(check.markerFloor(["python_full_version >= '3.12' and sys_platform == 'win32'"], '3.10'), null);
  assert.equal(check.admitsPython('>=3.11', '3.10'), false);
  assert.equal(check.admitsPython('!=3.0.*,!=3.1.*,>=2.7', '3.10'), true);
  assert.equal(check.admitsPython('~=3.9', '3.10'), true);
  assert.equal(check.admitsPython('<3.10', '3.10'), false);
  assert.equal(check.readUvLock('requires-python = "==3.13.*"\n', 'x/uv.lock').floor, '3.13');
  assert.throws(() => check.readUvLock('version = 1\n', 'x/uv.lock'), /Could not read the Python floor in x\/uv\.lock/);
});

test('an unreachable registry refuses with 1 line naming what could not be checked', async t => {
  for (const [url, message] of [
    ['https://registry.npmjs.org/vite', 'Could not check npm vite: HTTP 404'],
    ['https://crates.io/api/v1/crates/tokio', 'Could not check crates.io tokio: HTTP 404'],
    ['https://crates.io/api/v1/crates/lancedb/0.41.0/dependencies', 'Could not check crates.io lancedb 0.41.0: HTTP 404'],
    ['https://pypi.org/pypi/six/json', 'Could not check PyPI six: HTTP 404'],
  ]) {
    const { root, answers } = options(t);
    delete answers[url];
    const printed = [], errors = [];
    const code = await check.main([], { root, now: NOW, delay: async () => {}, uvLocks: ['lance-maintenance/uv.lock'],
      gitHead: () => 'a'.repeat(40), fetchJson: async u => { if (!(u in answers)) throw new Error('HTTP 404'); return structuredClone(answers[u]); },
      print: line => printed.push(line), printError: line => errors.push(line) });
    assert.equal(code, 1);
    assert.deepEqual(errors, [message]);
    assert.deepEqual(printed, []);
  }
  const { root } = options(t);
  const errors = [];
  const code = await check.main([], { root, now: NOW, uvLocks: ['lance-maintenance/uv.lock'], gitHead: () => { throw new Error('Could not resolve host: github.com'); },
    fetchJson: async () => { throw new Error('fetch failed'); }, print: () => {}, printError: line => errors.push(line) });
  assert.equal(code, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Could not check /);
});

test('main exits 1 with 1 line per lagging package, 0 when current, and takes no flags', async t => {
  const { root, answers } = options(t);
  const base = { root, now: NOW, delay: async () => {}, uvLocks: ['lance-maintenance/uv.lock'], gitHead: () => 'a'.repeat(40),
    fetchJson: async url => structuredClone(answers[url]) };
  const printed = [];
  assert.equal(await check.main([], { ...base, print: line => printed.push(line), printError: line => printed.push(line) }), 0);
  assert.deepEqual(printed, ['Every dependency is at its latest release: 6 npm, 5 Rust, 4 Python']);
  answers['https://crates.io/api/v1/crates/arrow-array'] = crateEntry(['58.4.1', '60.1.0']);
  printed.length = 0;
  assert.equal(await check.main([], { ...base, print: line => printed.push(line), printError: line => printed.push(line) }), 0);
  assert.deepEqual(printed, ['cargo arrow-array 58.4.1, held by lance 14.0.2 (^58.0.0); latest 60.1.0',
    "Every dependency is at its latest release: 6 npm, 5 Rust, 4 Python, 1 held by a parent's requirement"]);
  answers['https://crates.io/api/v1/crates/arrow-array'] = crateEntry(['58.4.1']);
  answers['https://crates.io/api/v1/crates/tokio'] = { crate: { max_stable_version: '1.49.0' } };
  answers['https://pypi.org/pypi/six/json'] = pypiEntry({ '1.18.0': {} });
  printed.length = 0;
  assert.equal(await check.main([], { ...base, print: line => printed.push(line), printError: line => printed.push(line) }), 1);
  assert.deepEqual(printed, ['cargo tokio 1.48.0, latest 1.49.0', 'pypi lance-maintenance/uv.lock six 1.17.0, latest 1.18.0']);
  const errors = [];
  assert.equal(await check.main(['--skip'], { ...base, print: () => {}, printError: line => errors.push(line) }), 2);
  assert.deepEqual(errors, ['Usage: node scripts/check-versions.cjs']);
});
