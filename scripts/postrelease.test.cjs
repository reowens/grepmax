const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const net = require('node:net');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

const repository = resolve(__dirname, '..');
const script = join(repository, 'scripts/postrelease.sh');
const VERSION = '9.9.9';

const stub = (body) => `#!/usr/bin/env bash\necho "$*" >> "$STUB_LOG/$(basename "$0").log"\n${body}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gpr-'));
  const home = join(root, 'home'), bin = join(root, 'bin'), logs = join(root, 'logs');
  const unitNode = join(root, 'unit-node/bin'), prefix = join(root, 'unit-prefix');
  for (const dir of [home, bin, logs, unitNode, join(home, '.gmax')]) mkdirSync(dir, { recursive: true });
  const write = (path, body) => writeFileSync(path, body, { mode: 0o755 });
  write(join(bin, 'systemctl'), stub(`
case "$*" in
  *"-p LoadState"*) [ "$STUB_UNIT" = absent ] && echo not-found || echo loaded ;;
  *"-p ActiveState"*) [ "$STUB_UNIT" = active ] && echo active || echo inactive ;;
  *"-p UnitFileState"*) [ "$STUB_UNIT" = absent ] || echo enabled ;;
  *"-p ExecStart"*) [ "$STUB_UNIT" = absent ] || echo "{ path=$STUB_NODE ; argv[]=$STUB_NODE $STUB_PREFIX/lib/node_modules/grepmax/dist/bin.js watch --daemon ; ignore_errors=no }" ;;
  *restart*) exit "\${STUB_RESTART_EXIT:-0}" ;;
esac`));
  write(join(bin, 'npm'), stub('exit 0'));
  write(join(unitNode, 'npm'), '#!/usr/bin/env bash\necho "$*" >> "$STUB_LOG/unit-npm.log"\necho "PATH0=${PATH%%:*}" >> "$STUB_LOG/unit-npm.log"\n');
  write(join(unitNode, 'node'), stub('exit 1'));
  write(join(bin, 'gmax'), stub('exit 0'));
  write(join(bin, 'pgrep'), stub('exit "${STUB_PGREP_EXIT:-1}"'));
  write(join(bin, 'sleep'), stub('exit 0'));
  const log = (name) => {
    const path = join(logs, `${name}.log`);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  };
  return { root, home, bin, logs, unitNode, prefix, log };
}

function serveVersion(home, version) {
  const server = net.createServer((conn) => {
    conn.on('data', () => conn.end(JSON.stringify({ ok: true, version }) + '\n'));
  });
  return new Promise((done) => server.listen(join(home, '.gmax/daemon.sock'), () => done(server)));
}

function run(fx, extra) {
  const env = {
    PATH: `${fx.bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    HOME: fx.home,
    STUB_LOG: fx.logs,
    STUB_NODE: join(fx.unitNode, 'node'),
    STUB_PREFIX: fx.prefix,
    npm_package_version: VERSION,
    ...extra,
  };
  return new Promise((done) => {
    const child = spawn('bash', [script, '--install'], { cwd: repository, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

async function withFixture(fn) {
  const fx = fixture();
  try { await fn(fx); } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

test('an active gmax.service unit gets the install in its own prefix and a systemd restart, confirmed over IPC', () =>
  withFixture(async (fx) => {
    const server = await serveVersion(fx.home, VERSION);
    try {
      const result = await run(fx, { STUB_UNIT: 'active' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(fx.log('npm'), '');
      assert.match(fx.log('unit-npm'), new RegExp(`^pack --min-release-age=0 --prefer-online --pack-destination \\S+ grepmax@${VERSION}$`, 'm'));
      assert.match(fx.log('unit-npm'), new RegExp(`^install -g --prefix ${fx.prefix} \\S+/grepmax-${VERSION}\\.tgz$`, 'm'), 'the fetched archive, so its dependencies keep the cooldown');
      assert.match(fx.log('unit-npm'), new RegExp(`^PATH0=${fx.unitNode}$`, 'm'));
      assert.match(fx.log('systemctl'), /^--user restart gmax\.service$/m);
      assert.equal(fx.log('gmax'), '');
      assert.equal(fx.log('pgrep'), '');
      assert.match(result.stdout, /daemon serving 9\.9\.9 \(confirmed over IPC\)/);
      assert.equal(result.stderr, '');
    } finally { server.close(); }
  }));

test('an active unit whose daemon never reports the new version warns and still exits 0', () =>
  withFixture(async (fx) => {
    const server = await serveVersion(fx.home, '9.9.8');
    try {
      const result = await run(fx, { STUB_UNIT: 'active' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(fx.log('systemctl'), /^--user restart gmax\.service$/m);
      assert.match(result.stderr, /WARN: daemon reports '9\.9\.8', expected 9\.9\.9\./);
      assert.match(result.stderr, /Restart manually: systemctl --user restart gmax\.service/);
      assert.equal(fx.log('gmax'), '');
    } finally { server.close(); }
  }));

test('a failed systemd restart warns and still exits 0', () =>
  withFixture(async (fx) => {
    const result = await run(fx, { STUB_UNIT: 'active', STUB_RESTART_EXIT: '1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /WARN: systemctl --user restart gmax\.service failed/);
    assert.equal(fx.log('gmax'), '');
  }));

test('an enabled unit that is not running gets the install in its prefix and no restart', () =>
  withFixture(async (fx) => {
    const result = await run(fx, { STUB_UNIT: 'enabled' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(fx.log('unit-npm'), new RegExp(`--prefix ${fx.prefix} `));
    assert.doesNotMatch(fx.log('systemctl'), /restart/);
    assert.match(result.stdout, /gmax\.service is not active; skipping restart/);
    assert.equal(fx.log('gmax'), '');
  }));

test('under host quarantine the unit gets the install but no restart', () =>
  withFixture(async (fx) => {
    writeFileSync(join(fx.home, '.gmax/safety-stop.json'), '{}');
    const result = await run(fx, { STUB_UNIT: 'active' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(fx.log('unit-npm'), new RegExp(`--prefix ${fx.prefix} `));
    assert.doesNotMatch(fx.log('systemctl'), /restart/);
    assert.equal(fx.log('gmax'), '');
    assert.match(result.stdout, /Host quarantine is active/);
  }));

test('with no unit the global install and gmax handover run as before, confirmed over IPC', () =>
  withFixture(async (fx) => {
    const server = await serveVersion(fx.home, VERSION);
    try {
      const result = await run(fx, { STUB_UNIT: 'absent', STUB_PGREP_EXIT: '0' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(fx.log('npm'), new RegExp(`^pack --min-release-age=0 --prefer-online --pack-destination \\S+ grepmax@${VERSION}\ninstall -g \\S+/grepmax-${VERSION}\\.tgz\n$`));
      assert.equal(fx.log('unit-npm'), '');
      assert.match(fx.log('pgrep'), /^-x gmax-daemon$/m);
      assert.equal(fx.log('gmax'), 'watch --daemon -b\n');
      assert.doesNotMatch(fx.log('systemctl'), /restart/);
      assert.match(result.stdout, /daemon serving 9\.9\.9 \(confirmed over IPC\)/);
    } finally { server.close(); }
  }));

test('with no unit and a daemon that keeps the old version the plain path warns and exits 0', () =>
  withFixture(async (fx) => {
    const result = await run(fx, { STUB_UNIT: 'absent', STUB_PGREP_EXIT: '0' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fx.log('gmax'), 'watch --daemon -b\n');
    assert.match(result.stderr, /WARN: daemon reports 'no response', expected 9\.9\.9\./);
    assert.match(result.stderr, /Restart manually: gmax watch --daemon -b/);
  }));

test('with no unit and no daemon running nothing is restarted', () =>
  withFixture(async (fx) => {
    const result = await run(fx, { STUB_UNIT: 'absent' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(fx.log('npm'), new RegExp(`^pack --min-release-age=0 --prefer-online --pack-destination \\S+ grepmax@${VERSION}\ninstall -g \\S+/grepmax-${VERSION}\\.tgz\n$`));
    assert.equal(fx.log('gmax'), '');
    assert.match(result.stdout, /No daemon running/);
  }));
