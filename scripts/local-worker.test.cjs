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
