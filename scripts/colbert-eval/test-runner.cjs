'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  runBoundedChild, runValidation, RUNNER_DEFAULT_LIMITS: DEFAULTS,
  limitsFor, validateSample, validateValidationResponse, parseLinuxMemory, cpuSeconds,
} = require('./runner.cjs');
const fixture = path.join(__dirname, 'fixtures', 'child.cjs');
const roots = [];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function healthy(extra = {}) {
  return { experimentDiskBytes: 1024, hostFreeDiskBytes: 100 * 1024 ** 3,
    ownedRssBytes: 1024, ownedCpuSeconds: 0, hostAvailableMemoryBytes: 32 * 1024 ** 3,
    swapUsedBytes: 1024, memoryPressure: 'normal', ownedPids: [], ...extra };
}
async function run(mode = 'echo', options = {}) {
  const result = await runBoundedChild({ command: process.execPath, args: [fixture, mode],
    syntheticFixture: true, sampler: async () => healthy(), limits: { deadlineMs: 2500 }, ...options });
  roots.push(result.evaluationRoot);
  return result;
}
after(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); });

test('defaults pin the Wave 1 resource budget and only permit stricter overrides', () => {
  assert.equal(DEFAULTS.deadlineMs, 1800000);
  assert.equal(DEFAULTS.maxOwnedRssBytes, 6 * 1024 ** 3);
  assert.equal(DEFAULTS.maxSwapGrowthBytes, 512 * 1024 ** 2);
  assert.equal(DEFAULTS.maxExperimentDiskBytes, 12 * 1024 ** 3);
  assert.equal(DEFAULTS.minHostAvailableMemoryBytes, 8 * 1024 ** 3);
  assert.equal(DEFAULTS.minHostFreeDiskBytes, 15 * 1024 ** 3);
  assert.equal(DEFAULTS.sampleIntervalMs, 1000);
  assert.equal(limitsFor({ deadlineMs: 5 }).deadlineMs, 5);
  for (const limits of [{ deadlineMs: 0 }, { deadlineMs: -1 }, { deadlineMs: Infinity }, { deadlineMs: NaN },
    { deadlineMs: 1800001 }, { deadlineMs: 1.5 }, { maxOwnedRssBytes: DEFAULTS.maxOwnedRssBytes + 1 },
    { sampleIntervalMs: 999 }, { sampleIntervalMs: 2000 }, { sampleIntervalMs: Number.MAX_SAFE_INTEGER },
    { minHostAvailableMemoryBytes: 1 }, { minHostFreeDiskBytes: 1 },
    { maxInputBytes: 4194305 }, { invented: 1 }, { toString: 1 },
    JSON.parse('{"__proto__":1}')]) assert.throws(() => limitsFor(limits), { code: 'LIMITS' });
});
test('sampler parsing fails closed for missing, nonfinite and malformed readings', () => {
  for (const key of ['experimentDiskBytes', 'hostFreeDiskBytes', 'ownedRssBytes', 'ownedCpuSeconds', 'hostAvailableMemoryBytes', 'swapUsedBytes']) {
    for (const value of [undefined, NaN, Infinity, -1, '42']) assert.throws(() => validateSample(healthy({ [key]: value })), { code: 'SAMPLING' });
  }
  assert.throws(() => validateSample(healthy({ memoryPressure: 'unknown' })), { code: 'SAMPLING' });
  assert.throws(() => validateSample(healthy({ ownedPids: [1] })), { code: 'SAMPLING' });
  assert.deepEqual(parseLinuxMemory('MemAvailable: 10 kB\nSwapTotal: 20 kB\nSwapFree: 12 kB\n'), { hostAvailableMemoryBytes: 10240, swapUsedBytes: 8192 });
  assert.throws(() => parseLinuxMemory('MemFree: 10 kB'), { code: 'SAMPLING' });
  assert.throws(() => parseLinuxMemory('MemAvailable: 10 kB\nSwapTotal: 1 kB\nSwapFree: 2 kB\n'), { code: 'SAMPLING' });
  assert.equal(cpuSeconds('2-03:04:05.25'), 183845.25);
  assert.equal(cpuSeconds('00:01.25'), 1.25);
  assert.equal(cpuSeconds('130:55.44'), 7855.44);
  assert.throws(() => cpuSeconds('unknown'), { code: 'SAMPLING' });
  assert.throws(() => cpuSeconds('00:60.0'), { code: 'SAMPLING' });
  assert.throws(() => cpuSeconds('1-25:00:00'), { code: 'SAMPLING' });
});
test('bounded primitive rejects arbitrary commands, env injection and unowned fixture paths', async () => {
  const base = { syntheticFixture: true, command: process.execPath, args: [fixture] };
  for (const changes of [{ command: '/bin/sh' }, { args: ['-e', 'process.exit()'] },
    { args: [path.join(__dirname, 'adapter.py')] }, { syntheticFixture: false },
    { env: { HOME: '/tmp/override' } }, { args: [fixture, 'x\0y'] }]) {
    await assert.rejects(runBoundedChild({ ...base, ...changes }), (error) => ['FIXTURE_ONLY', 'OPTIONS'].includes(error.code));
  }
  await assert.rejects(run('echo', { input: Buffer.alloc(20), limits: { maxInputBytes: 10 } }), { code: 'INPUT_LIMIT' });
});
test('real child gets fresh private HOME/GMAX_HOME/cwd and no inherited model or production fields', async () => {
  const poison = { GMAX_HOME: '/never-access-production', GMAX_SHARED_ROOT: '/primary/sharedRoot',
    GMAX_STORE_PATH: '/never-access-production/store', HF_HOME: '/model-cache', PYTHONPATH: '/model-runtime',
    NODE_OPTIONS: '--this-option-must-not-reach-the-child', HTTPS_PROXY: 'http://127.0.0.1:9',
    HF_TOKEN: 'synthetic-not-a-secret', TMPDIR: '/never-access-production/tmp',
    TMP: '/never-access-production/tmp', TEMP: '/never-access-production/tmp' };
  const old = {};
  for (const [key, value] of Object.entries(poison)) { old[key] = process.env[key]; process.env[key] = value; }
  let result;
  try { result = await run('environment'); }
  finally { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.equal(result.ok, true, result.code);
  const { env, cwd, marker } = result.response;
  assert.equal(cwd, path.join(result.evaluationRoot, 'work'));
  assert.equal(env.HOME, path.join(result.evaluationRoot, 'home'));
  assert.equal(env.GMAX_HOME, path.join(result.evaluationRoot, 'gmax'));
  assert.ok(!result.evaluationRoot.startsWith('/never-access-production'));
  for (const key of ['GMAX_SHARED_ROOT', 'GMAX_STORE_PATH', 'PYTHONPATH', 'NODE_OPTIONS', 'HTTPS_PROXY', 'HF_TOKEN']) assert.equal(env[key], undefined);
  for (const value of Object.values(env)) assert.ok(!value.includes('/primary/sharedRoot'));
  assert.equal(env.HF_HUB_OFFLINE, '1');
  assert.equal(env.TRANSFORMERS_OFFLINE, '1');
  assert.equal(await fs.readFile(marker, 'utf8'), 'owned fixture only');
  assert.equal((await fs.stat(result.evaluationRoot)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(env.HOME)).mode & 0o777, 0o700);
  assert.equal(result.manifest.cleanup.noLiveOwnedProcesses, true);
  assert.equal(result.manifest.ownership.processGroupId, result.manifest.ownership.childPid);
  assert.notEqual(result.manifest.ownership.processGroupId, process.pid);
  assert.equal(result.manifest.isolation.filesystemSandbox, false);
});
test('manifest preserves exact wire hashes, argv, units, limits and evidence bytes', async () => {
  const input = Buffer.from('{"case":"owned"}\n');
  const first = await run('echo', { input });
  const second = await run();
  assert.notEqual(first.evaluationRoot, second.evaluationRoot);
  assert.equal(first.ok, true);
  const manifest = JSON.parse(await fs.readFile(first.manifestPath, 'utf8'));
  assert.equal(manifest.request.sha256, hash(input));
  assert.equal(manifest.response.sha256, hash(await fs.readFile(manifest.response.path)));
  assert.deepEqual(manifest.argv, [process.execPath, fixture, 'echo']);
  assert.equal(manifest.metricUnits.ownedCpuSeconds, 'seconds');
  assert.equal(manifest.sampling.intervalMs, 1000);
  assert.equal(manifest.samples.length, 1); // Honest: short child has no periodic RSS/CPU sample.
  assert.ok(manifest.sampling.limitations.some((entry) => entry.includes('Short children')));
  assert.equal(manifest.inferencePerformed, false);
  assert.equal(manifest.response.complete, true);
});
test('missing/unavailable/nonfinite sampler refuses before creating a child', async () => {
  for (const sampler of [async () => { throw new Error('unavailable'); }, async () => healthy({ ownedRssBytes: NaN })]) {
    const result = await run('hang', { sampler });
    assert.equal(result.ok, false);
    assert.equal(result.manifest.ownership.childPid, null);
    assert.equal(result.manifest.cleanup.noLiveOwnedProcesses, true);
  }
});
test('admission refuses host memory, free disk, pressure, RSS and experiment disk breaches', async () => {
  for (const [fields, code] of [
    [{ hostAvailableMemoryBytes: 1 }, 'RESOURCE_HOST_MEMORY'], [{ hostFreeDiskBytes: 1 }, 'RESOURCE_HOST_DISK'],
    [{ memoryPressure: 'warning' }, 'RESOURCE_MEMORY_PRESSURE'], [{ ownedRssBytes: DEFAULTS.maxOwnedRssBytes + 1 }, 'RESOURCE_RSS'],
    [{ experimentDiskBytes: DEFAULTS.maxExperimentDiskBytes + 1 }, 'RESOURCE_DISK'],
  ]) {
    const result = await run('hang', { sampler: async () => healthy(fields) });
    assert.equal(result.code, code);
    assert.equal(result.manifest.ownership.childPid, null);
  }
});
test('real owned timeout kills a resistant descendant and records checked cleanup', async () => {
  // Allow both Node processes to start and install their handlers under parallel
  // test load; killing a not-yet-initialized child does not exercise escalation.
  const result = await run('descendants', { limits: { deadlineMs: 2000 } });
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(result.manifest.cleanup.noLiveOwnedProcesses, true);
  assert.ok(result.manifest.cleanup.signals.includes('SIGKILL'));
  const descendant = Number(await fs.readFile(path.join(result.evaluationRoot, 'home', 'descendant.pid'), 'utf8'));
  assert.ok(result.manifest.ownership.observedPids.includes(descendant));
  const ps = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,pgid=,stat=']);
  const survivors = ps.stdout.split('\n').filter((line) => {
    const fields = line.trim().split(/\s+/);
    return Number(fields[1]) === result.manifest.ownership.processGroupId && !fields[2]?.startsWith('Z');
  });
  assert.deepEqual(survivors, []);
});
test('root exit does not hide a descendant holding the protocol pipe open', async () => {
  const result = await run('orphan', { limits: { deadlineMs: 350 } });
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(result.manifest.childExit.code, 0);
  assert.equal(result.manifest.cleanup.noLiveOwnedProcesses, true);
});
for (const unavailable of [false, true]) test(`root exit keeps descendant ${unavailable ? 'sampler failure' : 'RSS breach'} guards active`, async () => {
  let calls = 0;
  const result = await run('orphan', {
    limits: { deadlineMs: 4000 },
    sampler: async () => {
      if (++calls === 1) return healthy();
      if (unavailable) throw new Error('post-root-exit sampler unavailable');
      return healthy({ ownedRssBytes: DEFAULTS.maxOwnedRssBytes + 1 });
    },
  });
  assert.equal(result.manifest.childExit.code, 0, 'root exited normally before periodic refusal');
  assert.equal(calls, 2, 'owned group is sampled after root exit');
  assert.equal(result.code, unavailable ? 'SAMPLING' : 'RESOURCE_RSS');
  assert.equal(result.manifest.cleanup.noLiveOwnedProcesses, true);
  assert.ok(result.manifest.cleanup.signals.includes('SIGKILL'));
  const descendant = Number(await fs.readFile(path.join(result.evaluationRoot, 'home', 'descendant.pid'), 'utf8'));
  assert.ok(result.manifest.ownership.observedPids.includes(descendant));
  if (!unavailable) assert.equal(result.manifest.samples.length, 2);
});
test('abort uses only the owned child group, including pre-aborted admission', async () => {
  const controller = new AbortController();
  const pending = run('descendants', { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 300);
  const result = await pending;
  clearTimeout(timer);
  assert.equal(result.code, 'ABORTED');
  assert.equal(result.manifest.cleanup.noLiveOwnedProcesses, true);
  const pre = new AbortController(); pre.abort();
  const beforeSpawn = await run('hang', { signal: pre.signal });
  assert.equal(beforeSpawn.code, 'ABORTED');
  assert.equal(beforeSpawn.manifest.ownership.childPid, null);
});
test('protocol refusal cleans up a live resistant descendant', async () => {
  const result = await run('malformed-descendant');
  assert.equal(result.code, 'PROTOCOL');
  assert.equal(result.manifest.cleanup.noLiveOwnedProcesses, true);
  assert.ok(result.manifest.cleanup.signals.includes('SIGKILL'));
});
test('resource growth, post-spawn sampling failure and RSS refusal clean the group', async () => {
  for (const [extra, code] of [[{ swapUsedBytes: DEFAULTS.maxSwapGrowthBytes + 1025 }, 'RESOURCE_SWAP'],
    [{ ownedRssBytes: 2049 }, 'RESOURCE_RSS'], [{ experimentDiskBytes: 2049 }, 'RESOURCE_DISK'],
    [{ ownedCpuSeconds: Infinity }, 'SAMPLING']]) {
    let calls = 0;
    const result = await run('descendants', { limits: { deadlineMs: 2200, maxOwnedRssBytes: 2048, maxExperimentDiskBytes: 2048 },
      sampler: async () => healthy(++calls === 1 ? {} : extra) });
    assert.equal(result.code, code);
    assert.equal(result.manifest.cleanup.noLiveOwnedProcesses, true);
    if (result.manifest.samples.length > 1) assert.ok(result.manifest.samples[1].elapsedMs - result.manifest.samples[0].elapsedMs >= 1000);
  }
});
test('unresponsive admission sampler is bounded by the same positive deadline', async () => {
  const result = await run('hang', { limits: { deadlineMs: 50 }, sampler: () => new Promise(() => {}) });
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(result.manifest.ownership.childPid, null);
});
test('stdout/stderr ceilings retain only bounded bytes and clean the child', async () => {
  for (const [mode, code] of [['stdout', 'STDOUT_LIMIT'], ['stderr', 'STDERR_LIMIT']]) {
    const result = await run(mode, { limits: { deadlineMs: 1500, maxStdoutBytes: 1024, maxStderrBytes: 1024 } });
    assert.equal(result.code, code);
    assert.ok(result.manifest.response.retainedBytes <= 1024);
    assert.ok(result.manifest.stderr.retainedBytes <= 1024);
    assert.equal(result.manifest.cleanup.noLiveOwnedProcesses, true);
  }
});
test('malformed, duplicate, unterminated, non-object and non-UTF8 frames fail closed', async () => {
  for (const mode of ['two-frames', 'unterminated', 'array', 'invalid-utf8']) {
    const result = await run(mode);
    assert.equal(result.code, 'PROTOCOL', mode);
    assert.equal(result.manifest.cleanup.noLiveOwnedProcesses, true);
  }
  assert.equal((await run('exit')).code, 'CHILD_EXIT');
});
test('CLI documents the validation payload and rejects arbitrary execution options', async () => {
  const cli = path.join(__dirname, 'runner.cjs');
  const help = await promisify(execFile)(process.execPath, [cli, '--help']);
  assert.match(help.stdout, /--request \/path\/to\/request.json/);
  assert.match(help.stdout, /No infer operation/);
  await assert.rejects(promisify(execFile)(process.execPath, [cli, '--command', '/bin/sh']), (error) => error.code === 1 && /"code":"CLI"/.test(error.stderr));
});

// The parent creates these modules concurrently. Do not replace their interface
// with a local fake: integration tests run when the real files are available.
test('fixed adapter validation route and default inference refusal', async (t) => {
  try { await fs.access(path.join(__dirname, 'contract.cjs')); await fs.access(path.join(__dirname, 'adapter.py')); }
  catch { t.skip('Parent contract / owned adapter not available yet; rerun integration after handback'); return; }
  const request = JSON.parse(await fs.readFile(path.join(__dirname, 'fixtures', 'synthetic-validate-request.json'), 'utf8'));
  const result = await runValidation(request, { sampler: async () => healthy(), limits: { deadlineMs: 3000 } });
  roots.push(result.evaluationRoot);
  assert.equal(result.ok, true, JSON.stringify({ code: result.code, stderr: result.stderr }));
  assert.deepEqual(result.response.ids, ['q1']);
  assert.equal(result.response.inferencePerformed, false);
  assert.deepEqual(result.manifest.argv.slice(1), ['-I', '-B', '-S', path.join(__dirname, 'adapter.py')]);
  await assert.rejects(runValidation({ ...request, operation: 'infer' }));
  await assert.rejects(runValidation(request, { command: '/bin/sh' }), { code: 'OPTIONS' });
  await assert.rejects(runValidation({ ...request, inputs: [...request.inputs, ...request.inputs] }));
  await assert.rejects(runValidation({ ...request, inputs: [{ ...request.inputs[0], attentionMask: [1] }] }));
  await assert.rejects(runValidation({ ...request, inputs: [{ ...request.inputs[0], inputIds: [-1, 2, 3] }] }));
  const response = result.response;
  for (const changes of [{ requestId: 'wrong' }, { operation: 'infer' }, { inferencePerformed: true },
    { dimensions: 32 }, { ids: ['q2'] }, { vectors: [] }, { runtime: 'hidden' }, { ok: 1 }]) {
    assert.throws(() => validateValidationResponse({ ...response, ...changes }, request), { code: 'PROTOCOL' });
  }
  const error = { schemaVersion: 1, requestId: request.requestId, ok: false, error: { code: 'refused', message: 'Synthetic refusal' }, inferencePerformed: false };
  assert.deepEqual(validateValidationResponse(error, request), error);
  assert.throws(() => validateValidationResponse({ ...error, stack: 'unrestricted' }, request), { code: 'PROTOCOL' });
  assert.throws(() => validateValidationResponse({ ...error, error: { code: 'REFUSED', message: 'x'.repeat(501) } }, request), { code: 'PROTOCOL' });
});
