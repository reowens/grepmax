const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { localWorkerCommand } = require('./local-worker.cjs');

test('Gmax repository entry delegates only to the adjacent local platform runner', () => {
  const root = mkdtempSync(join(tmpdir(), 'gmax-entry-fixture-'));
  try {
    const platformRoot = join(root, 'platform'); mkdirSync(join(platformRoot, 'scripts'), { recursive: true });
    writeFileSync(join(platformRoot, 'scripts/gmax-worker.mjs'), 'fixture');
    const args = localWorkerCommand(['run', '--task', 'unit', '--worker', 'p3', '--test', 'tests/a.test.ts'], { root, platformRoot });
    assert.equal(args[0], process.execPath); assert.equal(args[1], join(platformRoot, 'scripts/gmax-worker.mjs'));
    assert.deepEqual(args.slice(-2), ['--source-root', root]);
    assert.equal(localWorkerCommand(['prepare', '--worker', 'p3'], { root, platformRoot })[2], 'prepare');
    assert.throws(() => localWorkerCommand(['release:check'], { root, platformRoot }));
    assert.throws(() => localWorkerCommand(['run', '--source-root', '/other'], { root, platformRoot }));
    assert.throws(() => localWorkerCommand(['describe'], { root, platformRoot: join(root, 'absent') }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('pnpm worker scripts forward one selected task and exact arguments through the repository entry', () => {
  const { readFileSync, realpathSync } = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const { resolve } = require('node:path');
  const { pathToFileURL } = require('node:url');
  const repository = resolve(__dirname, '..');
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gmax-pnpm-entry-')));
  const root = join(base, 'gmax'), platform = join(base, 'platform');
  const parser = pathToFileURL(resolve(repository, '../../platform/scripts/gmax-worker.mjs')).href;
  const tasks = { 'worker:prepare': 'prepare', 'worker:typecheck': 'typecheck', 'worker:test': 'unit',
    'worker:package': 'package', 'worker:compatibility': 'compatibility', 'worker:native-build': 'native-build' };
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(join(platform, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'gmax-entry-fixture', version: '0.0.0',
      scripts: Object.fromEntries(Object.keys(tasks).map(name => [name, manifest.scripts[name]])) }));
    writeFileSync(join(root, 'scripts/local-worker.cjs'), readFileSync(join(repository, 'scripts/local-worker.cjs')));
    writeFileSync(join(platform, 'scripts/gmax-worker.mjs'), `import { parseGmaxArgs } from ${JSON.stringify(parser)};
const selection = parseGmaxArgs(process.argv.slice(2));
console.log('GMAX_FIXTURE=' + JSON.stringify(selection));
process.exitCode = selection.worker === 'fixture-refuse' ? 75 : 0;
`);
    const ref = 'a'.repeat(40);
    for (const [name, task] of Object.entries(tasks)) {
      const args = ['--worker', 'p3', '--ref', ref, '--timeout', '60'];
      if (task === 'unit') args.push('--test', 'tests/core.test.ts');
      const result = spawnSync('pnpm', ['--dir', root, 'run', name, ...args], { encoding: 'utf8', timeout: 15000, shell: false });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const lines = result.stdout.split('\n').filter(line => line.startsWith('GMAX_FIXTURE='));
      assert.equal(lines.length, 1);
      const selection = JSON.parse(lines[0].slice('GMAX_FIXTURE='.length));
      assert.equal(selection.task, task); assert.equal(selection.worker, 'p3');
      assert.equal(selection.ref, ref); assert.equal(selection.timeoutS, 60); assert.equal(selection.sourceRoot, root);
      assert.deepEqual(selection.tests, task === 'unit' ? ['tests/core.test.ts'] : []);
    }
    const refused = spawnSync('pnpm', ['--dir', root, 'run', 'worker:typecheck', '--worker', 'fixture-refuse'],
      { encoding: 'utf8', timeout: 15000, shell: false });
    assert.equal(refused.status, 75); assert.equal(refused.stdout.split('GMAX_FIXTURE=').length, 2);
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (!name.startsWith('worker:')) assert.equal(command.includes('local-worker.cjs'), false, `${name} changed its execution path`);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
