#!/usr/bin/env node
// After `npm version` has pushed v<version>: rebuild the archive the way
// release.yml rebuilds it, write its source receipt, attach both to a draft
// GitHub release and print the release.yml dispatch.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const REPO = 'reowens/grepmax';
const NATIVE_FILES = ['manifest.json', 'acceptance.json', 'THIRD-PARTY-NOTICES.txt',
  'gmax-bounded-maintenance-darwin-arm64', 'gmax-bounded-maintenance-linux-x64'];
const USAGE = 'Usage: node scripts/release-draft.cjs [--dry-run] [--dispatch] [--native <dir>] [--out <dir>] [--notes-file <file>]';

function parseArgs(argv) {
  const options = { dryRun: false, dispatch: false, native: undefined, out: undefined, notesFile: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--dispatch') options.dispatch = true;
    else if (['--native', '--out', '--notes-file'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      options[{ '--native': 'native', '--out': 'out', '--notes-file': 'notesFile' }[arg]] = path.resolve(argv[++i]);
    } else throw new Error(USAGE);
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, shell: false, ...options });
  return { status: result.error ? 127 : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error?.message || '') };
}

function must(command, args, options, exec = run) {
  const result = exec(command, args, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).pop() ?? `exit ${result.status}`;
    throw new Error(`${command} ${args[0]} failed: ${detail}`);
  }
  return result.stdout;
}

// release.yml is the contract, so its pinned toolchain is read from it.
function releaseToolchain(root) {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const node = workflow.match(/node-version:\s*['"]([0-9.]+)['"]/)?.[1];
  const pnpm = workflow.match(/pnpm\/action-setup@[\s\S]*?version:\s*['"]([0-9.]+)['"]/)?.[1];
  const npm = workflow.match(/npm install --global npm@([0-9.]+)/)?.[1];
  if (!node || !pnpm || !npm) throw new Error('release.yml no longer names its node, npm and pnpm versions');
  return { node, npm, pnpm };
}

// npm is the packer, so it must match exactly. The tar bytes come from npm's
// own JavaScript; a node patch release changes only gzip, which release.yml
// tolerates once the uncompressed tar matches. Node major.minor must match.
function toolchainRefusal(actual, expected) {
  if (actual.npm !== expected.npm) return `npm ${actual.npm} differs from release.yml's npm ${expected.npm}; the packer must match exactly`;
  const [major, minor] = expected.node.split('.');
  const [actualMajor, actualMinor] = actual.node.replace(/^v/, '').split('.');
  if (actualMajor !== major || actualMinor !== minor) return `node ${actual.node} differs from release.yml's node ${expected.node} beyond a patch release`;
  return null;
}

function nativeRefusal(nativeDir) {
  const missing = NATIVE_FILES.filter(name => !fs.statSync(path.join(nativeDir, name), { throwIfNoEntry: false })?.isFile());
  return missing.length ? `Qualified native artifacts missing in ${nativeDir}: ${missing.join(', ')}` : null;
}

// Each check returns 1 plain refusal line, or null when the release may proceed.
function checkPreconditions({ root, nativeDir, toolchain, git = (...args) => run('git', ['-C', root, ...args]) }) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const tag = `v${version}`;
  if (git('diff', '--quiet').status !== 0 || git('diff', '--cached', '--quiet').status !== 0) {
    return { refusal: 'The working tree has uncommitted changes; commit or set them aside first' };
  }
  const tagged = git('rev-parse', '--verify', '--quiet', `${tag}^{commit}`);
  const head = git('rev-parse', 'HEAD').stdout.trim();
  if (tagged.status !== 0) return { refusal: `Tag ${tag} does not exist; run npm version first` };
  const commit = tagged.stdout.trim();
  if (commit !== head) return { refusal: `HEAD ${head.slice(0, 12)} is not ${tag} (${commit.slice(0, 12)}); check out the release tag` };
  const native = nativeRefusal(nativeDir);
  if (native) return { refusal: native };
  const toolchainLine = toolchainRefusal(toolchain.actual, toolchain.expected);
  if (toolchainLine) return { refusal: toolchainLine };
  return { refusal: null, version, tag, commit };
}

function remoteRefusal({ tag, commit, git, gh }) {
  const listed = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
  if (listed.status !== 0) return `Could not read tags from origin: ${listed.stderr.trim().split('\n').pop()}`;
  const refs = Object.fromEntries(listed.stdout.trim().split('\n').filter(Boolean).map(line => line.split('\t').reverse()));
  const remote = refs[`refs/tags/${tag}^{}`] ?? refs[`refs/tags/${tag}`];
  if (!remote) return `Tag ${tag} is not on origin; push it first`;
  if (remote !== commit) return `Tag ${tag} on origin points at ${remote.slice(0, 12)}, not ${commit.slice(0, 12)}`;
  const existing = gh(['release', 'view', tag, '--repo', REPO, '--json', 'isDraft']);
  if (existing.status === 0) return `Release ${tag} already exists on ${REPO}`;
  if (!/not found/i.test(existing.stderr)) return `Could not check for an existing release: ${existing.stderr.trim().split('\n').pop() || `gh exit ${existing.status}`}`;
  return null;
}

function receiptText({ version, commit, archive, sha256 }) {
  return `${JSON.stringify({ version, sourceCommit: commit, gitTag: `v${version}`, archive, sha256 }, null, 2)}\n`;
}

function releaseCreateArgs({ tag, version, archivePath, receiptPath, notesFile }) {
  return ['release', 'create', tag, '--draft', '--verify-tag', '--repo', REPO, '--title', `grepmax ${version}`,
    ...(notesFile ? ['--notes-file', notesFile] : ['--notes', '']), archivePath, receiptPath];
}

function dispatchArgs({ version, commit, sha256 }) {
  return ['workflow', 'run', 'release.yml', '--repo', REPO, '--ref', 'main',
    '-f', `version=${version}`, '-f', `source_commit=${commit}`, '-f', `archive_sha256=${sha256}`];
}

function shellLine(args) {
  return ['gh', ...args].map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
}

function sha256File(file) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(8 * 1024 ** 2);
    for (let read; (read = fs.readSync(descriptor, buffer)) > 0;) digest.update(buffer.subarray(0, read));
  } finally { fs.closeSync(descriptor); }
  return digest.digest('hex');
}

function tarSha256(file) {
  return crypto.createHash('sha256').update(zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: 2 * 1024 ** 3 })).digest('hex');
}

// Mirrors release.yml's build step on a clean export of the tagged commit,
// so ignored or untracked files in this checkout never reach the archive.
function buildRelease({ root, commit, version, nativeDir, outDir, pnpm, log = () => {} }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'grepmax-release-'));
  try {
    const source = path.join(work, 'source');
    const native = path.join(work, 'native');
    fs.mkdirSync(source);
    fs.mkdirSync(native);
    log(`Exporting ${commit.slice(0, 12)} to ${source}`);
    must('git', ['-C', root, 'archive', '--format=tar', '-o', path.join(work, 'source.tar'), commit]);
    must('tar', ['-xf', path.join(work, 'source.tar'), '-C', source]);
    for (const name of NATIVE_FILES) fs.copyFileSync(path.join(nativeDir, name), path.join(native, name));
    const inSource = { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] };
    log('Installing locked build tools');
    must(pnpm[0], [...pnpm.slice(1), 'install', '--frozen-lockfile', '--ignore-scripts'], inSource);
    log('Building');
    must('node', ['scripts/prepare-lance-runtime.cjs'], inSource);
    must(pnpm[0], [...pnpm.slice(1), 'exec', 'tsc'], inSource);
    for (const name of ['dist/bin.js', 'dist/index.js']) fs.chmodSync(path.join(source, name), 0o755);
    must('node', ['scripts/prepare-bounded-runtime.cjs', native, 'dist/vendor/maintenance', '--required'], inSource);
    log('Packing');
    fs.mkdirSync(outDir, { recursive: true });
    const metadata = JSON.parse(must('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outDir], inSource))[0];
    const archive = `grepmax-${version}.tgz`;
    if (metadata.filename !== archive || metadata.name !== 'grepmax' || metadata.version !== version) {
      throw new Error(`npm pack produced ${metadata.filename}, expected ${archive}`);
    }
    const packed = new Set(metadata.files.map(file => file.path));
    const absent = NATIVE_FILES.filter(name => !packed.has(`dist/vendor/maintenance/${name}`));
    if (absent.length) throw new Error(`Archive lacks native payloads: ${absent.join(', ')}`);
    const archivePath = path.join(outDir, archive);
    return { archive, archivePath, sha256: sha256File(archivePath), tarSha256: tarSha256(archivePath) };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

function main(argv, { root = path.resolve(__dirname, '..'), exec = run, build = buildRelease, print = console.log } = {}) {
  const options = parseArgs(argv);
  const nativeDir = options.native ?? path.join(root, 'lance-maintenance/artifacts');
  const expected = releaseToolchain(root);
  const required = (command, args, extra) => must(command, args, extra, exec);
  const version = command => exec(command, ['--version']).stdout.trim();
  const pnpm = ['npm', 'exec', '--yes', `--package=pnpm@${expected.pnpm}`, '--', 'pnpm'];
  const actual = { node: version('node'), npm: version('npm') };
  const git = (...args) => exec('git', ['-C', root, ...args]);
  const gh = args => exec('gh', args);
  const checked = checkPreconditions({ root, nativeDir, toolchain: { actual, expected }, git });
  if (checked.refusal) throw new Error(checked.refusal);
  const remote = remoteRefusal({ ...checked, git, gh });
  if (remote) throw new Error(remote);
  const pnpmVersion = required(pnpm[0], [...pnpm.slice(1), '--version'], { cwd: os.tmpdir() }).trim();
  if (pnpmVersion !== expected.pnpm) throw new Error(`pnpm ${pnpmVersion} differs from release.yml's pnpm ${expected.pnpm}`);
  print(`==> ${checked.tag} at ${checked.commit}; node ${actual.node}, npm ${actual.npm}, pnpm ${pnpmVersion} (release.yml: node ${expected.node})`);

  const outDir = options.out ?? fs.mkdtempSync(path.join(os.tmpdir(), `grepmax-${checked.tag}-`));
  const built = build({ root, ...checked, nativeDir, outDir, pnpm, log: line => print(`==> ${line}`) });
  const receiptPath = path.join(outDir, 'release-SOURCE-ARTIFACT.json');
  fs.writeFileSync(receiptPath, receiptText({ ...checked, ...built }));
  print(`==> Archive ${built.archivePath}\n    sha256 ${built.sha256}\n    uncompressed tar sha256 ${built.tarSha256}\n==> Receipt ${receiptPath}`);

  const create = releaseCreateArgs({ ...checked, ...built, receiptPath, notesFile: options.notesFile });
  const dispatch = dispatchArgs({ ...checked, ...built });
  if (options.dryRun) {
    print(`==> Dry run: no GitHub writes. Would run:\n    ${shellLine(create)}`);
  } else {
    required('gh', create);
    const view = JSON.parse(required('gh', ['release', 'view', checked.tag, '--repo', REPO, '--json', 'isDraft,assets']));
    const digests = Object.fromEntries(view.assets.map(asset => [asset.name, asset.digest]));
    if (!view.isDraft || digests[built.archive] !== `sha256:${built.sha256}` || digests['release-SOURCE-ARTIFACT.json'] !== `sha256:${sha256File(receiptPath)}`) {
      throw new Error(`Draft ${checked.tag} does not hold the built archive and receipt; inspect it before dispatching`);
    }
    print(`==> Draft ${checked.tag} holds the archive and receipt with matching digests`);
  }
  print(`==> Dispatch:\n    ${shellLine(dispatch)}`);
  if (options.dispatch && !options.dryRun) {
    required('gh', dispatch);
    print('==> release.yml dispatched');
  }
  return { ...checked, ...built, receiptPath };
}

module.exports = { parseArgs, releaseToolchain, toolchainRefusal, nativeRefusal, checkPreconditions, remoteRefusal,
  receiptText, releaseCreateArgs, dispatchArgs, shellLine, buildRelease, tarSha256, main, NATIVE_FILES, REPO };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
