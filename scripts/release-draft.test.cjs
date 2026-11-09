const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const release = require('./release-draft.cjs');

const repository = path.resolve(__dirname, '..');
const toolchain = { node: '26.12.0', npm: '11.20.0', pnpm: '12.4.2' };

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// A tagged fixture checkout with a bare origin, the real release.yml and stand-in natives.
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grepmax-release-fixture-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'), origin = path.join(base, 'origin.git'), native = path.join(base, 'native');
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.mkdirSync(native);
  fs.copyFileSync(path.join(repository, '.github/workflows/release.yml'), path.join(root, '.github/workflows/release.yml'));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'grepmax', version: '1.2.3' })}\n`);
  for (const name of release.NATIVE_FILES) fs.writeFileSync(path.join(native, name), name);
  spawnSync('git', ['init', '--quiet', '--bare', origin]);
  git(base, 'init', '--quiet', root);
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  git(root, 'tag', '-a', 'v1.2.3', '-m', '1.2.3');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main', 'v1.2.3');
  const commit = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const repoGit = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const check = (overrides = {}) => release.checkPreconditions({ root, nativeDir: native,
    toolchain: { actual: { node: 'v26.12.1', npm: '11.20.0' }, expected: toolchain }, git: repoGit, ...overrides });
  return { base, root, native, origin, commit, repoGit, check };
}

// Real git; node, npm and pnpm report the given versions; every gh call is recorded.
function stubExec({ gh = () => ({ status: 1, stdout: '', stderr: 'release not found' }), npm = '11.20.0' } = {}) {
  const calls = [];
  const exec = (command, args, options) => {
    if (command === 'git') {
      const result = spawnSync('git', args, { encoding: 'utf8', ...options });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    if (command === 'node') return { status: 0, stdout: 'v26.12.1\n', stderr: '' };
    if (command === 'npm') return { status: 0, stdout: `${args[0] === 'exec' ? toolchain.pnpm : npm}\n`, stderr: '' };
    if (command === 'gh') { calls.push(args); return gh(args); }
    throw new Error(`unexpected command ${command}`);
  };
  return { exec, calls };
}

function stubBuild({ outDir, version }) {
  fs.mkdirSync(outDir, { recursive: true });
  const archive = `grepmax-${version}.tgz`, archivePath = path.join(outDir, archive);
  fs.writeFileSync(archivePath, 'archive');
  return { archive, archivePath, sha256: crypto.createHash('sha256').update('archive').digest('hex'), tarSha256: 'f'.repeat(64) };
}

test('release.yml pins are read from the workflow contract', () => {
  assert.deepEqual(release.releaseToolchain(repository), toolchain);
});

test('release.yml pins are read in either quote style', (t) => {
  for (const quote of ["'", '"']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grepmax-release-quotes-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github/workflows/release.yml'), [
      `          node-version: ${quote}26.12.0${quote}`,
      '        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413',
      `          version: ${quote}12.4.2${quote}`,
      '          npm install --global npm@11.20.0 --ignore-scripts',
    ].join('\n'));
    assert.deepEqual(release.releaseToolchain(root), toolchain);
  }
});

test('npm must match exactly; node may differ only by a patch release', () => {
  assert.equal(release.toolchainRefusal({ node: 'v26.12.1', npm: '11.20.0' }, toolchain), null);
  assert.equal(release.toolchainRefusal({ node: 'v26.12.0', npm: '11.20.0' }, toolchain), null);
  assert.match(release.toolchainRefusal({ node: 'v26.12.1', npm: '11.21.0' }, toolchain), /^npm 11\.21\.0 differs/);
  assert.match(release.toolchainRefusal({ node: 'v26.13.0', npm: '11.20.0' }, toolchain), /^node v26\.13\.0 differs/);
  assert.match(release.toolchainRefusal({ node: 'v27.12.0', npm: '11.20.0' }, toolchain), /^node v27\.12\.0 differs/);
});

test('a clean checkout at the version tag with natives and the pinned toolchain passes', t => {
  const { check, commit } = fixture(t);
  assert.deepEqual(check(), { refusal: null, version: '1.2.3', tag: 'v1.2.3', commit });
});

test('each precondition refuses with 1 plain line', t => {
  const { root, native, check } = fixture(t);
  const line = overrides => { const { refusal } = check(overrides); assert.equal(refusal.includes('\n'), false); return refusal; };

  fs.rmSync(path.join(native, 'gmax-bounded-maintenance-linux-x64'));
  assert.equal(line(), `Qualified native artifacts missing in ${native}: gmax-bounded-maintenance-linux-x64`);
  fs.writeFileSync(path.join(native, 'gmax-bounded-maintenance-linux-x64'), 'restored');

  assert.match(line({ toolchain: { actual: { node: 'v26.12.1', npm: '10.9.0' }, expected: toolchain } }), /^npm 10\.9\.0 differs from release\.yml's npm 11\.20\.0/);

  fs.appendFileSync(path.join(root, 'package.json'), ' ');
  assert.match(line(), /^The working tree has uncommitted changes/);
  git(root, 'add', 'package.json');
  assert.match(line(), /^The working tree has uncommitted changes/);
  git(root, 'commit', '--quiet', '-m', 'after tag');
  assert.match(line(), /^HEAD [0-9a-f]{12} is not v1\.2\.3 \([0-9a-f]{12}\); check out the release tag$/);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ ...manifest, version: '1.2.4' })}\n`);
  git(root, 'commit', '--quiet', '-am', 'untagged version');
  assert.equal(line(), 'Tag v1.2.4 does not exist; run npm version first');
});

test('the tag must be on origin at the same commit, with no release yet', t => {
  const { root, commit, repoGit } = fixture(t);
  const absent = () => ({ status: 1, stdout: '', stderr: 'release not found' });
  const remote = gh => release.remoteRefusal({ tag: 'v1.2.3', commit, git: repoGit, gh });
  assert.equal(remote(absent), null);
  assert.equal(remote(() => ({ status: 0, stdout: '{}', stderr: '' })), 'Release v1.2.3 already exists on reowens/grepmax');
  assert.match(remote(() => ({ status: 4, stdout: '', stderr: 'gh auth login required' })), /^Could not check for an existing release: gh auth login required$/);
  assert.equal(release.remoteRefusal({ tag: 'v1.2.3', commit: 'a'.repeat(40), git: repoGit, gh: absent }),
    `Tag v1.2.3 on origin points at ${commit.slice(0, 12)}, not aaaaaaaaaaaa`);
  git(root, 'push', '--quiet', 'origin', ':refs/tags/v1.2.3');
  assert.equal(remote(absent), 'Tag v1.2.3 is not on origin; push it first');
});

test('receipt bytes carry the 5 keys release.yml compares', () => {
  const text = release.receiptText({ version: '1.2.3', commit: 'c'.repeat(40), archive: 'grepmax-1.2.3.tgz', sha256: 'd'.repeat(64) });
  assert.equal(text, `{\n  "version": "1.2.3",\n  "sourceCommit": "${'c'.repeat(40)}",\n  "gitTag": "v1.2.3",\n  "archive": "grepmax-1.2.3.tgz",\n  "sha256": "${'d'.repeat(64)}"\n}\n`);
});

test('dispatch is off by default and its line names version, source and digest', () => {
  assert.equal(release.parseArgs([]).dispatch, false);
  assert.equal(release.parseArgs(['--dry-run']).dispatch, false);
  assert.throws(() => release.parseArgs(['--native']), /^Error: Usage/);
  assert.throws(() => release.parseArgs(['--publish']), /^Error: Usage/);
  assert.equal(release.shellLine(release.dispatchArgs({ version: '1.2.3', commit: 'c'.repeat(40), sha256: 'd'.repeat(64) })),
    `gh workflow run release.yml --repo reowens/grepmax --ref main -f version=1.2.3 -f source_commit=${'c'.repeat(40)} -f archive_sha256=${'d'.repeat(64)}`);
});

test('a dry run builds and writes the receipt but makes no GitHub write, even with --dispatch', t => {
  const { root, native, base, commit } = fixture(t);
  const { exec, calls } = stubExec();
  const printed = [];
  const out = path.join(base, 'out');
  const result = release.main(['--dry-run', '--dispatch', '--native', native, '--out', out], { root, exec, build: stubBuild, print: line => printed.push(line) });
  assert.deepEqual(calls, [['release', 'view', 'v1.2.3', '--repo', 'reowens/grepmax', '--json', 'isDraft']]);
  assert.equal(fs.readFileSync(path.join(out, 'release-SOURCE-ARTIFACT.json'), 'utf8'),
    release.receiptText({ version: '1.2.3', commit, archive: 'grepmax-1.2.3.tgz', sha256: result.sha256 }));
  const text = printed.join('\n');
  assert.match(text, /Dry run: no GitHub writes\. Would run:\n {4}gh release create v1\.2\.3 --draft --verify-tag --repo reowens\/grepmax --title 'grepmax 1\.2\.3' --notes '' /);
  assert.match(text, /gh workflow run release\.yml --repo reowens\/grepmax --ref main -f version=1\.2\.3/);
  assert.doesNotMatch(text, /dispatched/);
});

test('a real run creates the draft, confirms its digests and dispatches only on --dispatch', t => {
  const { root, native, base } = fixture(t);
  const receiptDigest = out => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(out, 'release-SOURCE-ARTIFACT.json'))).digest('hex')}`;
  for (const dispatch of [false, true]) {
    const out = path.join(base, `out-${dispatch}`);
    const { exec, calls } = stubExec({ gh: args => {
      if (args[1] === 'view' && args.includes('isDraft,assets')) {
        return { status: 0, stderr: '', stdout: JSON.stringify({ isDraft: true, assets: [
          { name: 'grepmax-1.2.3.tgz', digest: `sha256:${stubBuild({ outDir: out, version: '1.2.3' }).sha256}` },
          { name: 'release-SOURCE-ARTIFACT.json', digest: receiptDigest(out) }] }) };
      }
      return args[1] === 'view' ? { status: 1, stdout: '', stderr: 'release not found' } : { status: 0, stdout: '', stderr: '' };
    } });
    release.main(['--native', native, '--out', out, ...(dispatch ? ['--dispatch'] : [])], { root, exec, build: stubBuild, print: () => {} });
    const writes = calls.filter(args => args[1] !== 'view');
    assert.deepEqual(writes[0].slice(0, 8), ['release', 'create', 'v1.2.3', '--draft', '--verify-tag', '--repo', 'reowens/grepmax', '--title']);
    assert.deepEqual(writes.slice(1).map(args => args.slice(0, 3)), dispatch ? [['workflow', 'run', 'release.yml']] : []);
  }
});

test('a draft whose asset digests differ stops before the dispatch', t => {
  const { root, native, base } = fixture(t);
  const { exec, calls } = stubExec({ gh: args => args.includes('isDraft,assets')
    ? { status: 0, stderr: '', stdout: JSON.stringify({ isDraft: true, assets: [{ name: 'grepmax-1.2.3.tgz', digest: 'sha256:0' }] }) }
    : args[1] === 'view' ? { status: 1, stdout: '', stderr: 'release not found' } : { status: 0, stdout: '', stderr: '' } });
  assert.throws(() => release.main(['--dispatch', '--native', native, '--out', path.join(base, 'out')], { root, exec, build: stubBuild, print: () => {} }),
    /does not hold the built archive and receipt/);
  assert.equal(calls.some(args => args[0] === 'workflow'), false);
});
