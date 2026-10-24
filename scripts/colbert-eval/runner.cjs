#!/usr/bin/env node
'use strict';

// Validation/fixtures plus the explicit, fixed Mac smoke entrypoint. No service API.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify, TextDecoder } = require('node:util');
const { performance } = require('node:perf_hooks');
const { DEFAULT_LIMITS: CONTRACT_DEFAULTS, LIMITS: PROTOCOL_LIMITS, validateResponse, ProtocolError } = require('./contract.cjs');
const execFileAsync = promisify(execFile);
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const RUNNER_DEFAULT_LIMITS = Object.freeze({
  deadlineMs: CONTRACT_DEFAULTS.deadlineMs,
  maxOwnedRssBytes: CONTRACT_DEFAULTS.ownedRssBytes,
  maxSwapGrowthBytes: CONTRACT_DEFAULTS.maxSwapGrowthBytes,
  maxExperimentDiskBytes: CONTRACT_DEFAULTS.maxDiskBytes,
  minHostAvailableMemoryBytes: CONTRACT_DEFAULTS.minAvailableMemoryBytes,
  minHostFreeDiskBytes: CONTRACT_DEFAULTS.minFreeDiskBytes,
  sampleIntervalMs: CONTRACT_DEFAULTS.sampleIntervalMs,
  maxInputBytes: PROTOCOL_LIMITS.frameBytes,
  maxStdoutBytes: CONTRACT_DEFAULTS.maxStdoutBytes,
  maxStderrBytes: CONTRACT_DEFAULTS.maxStderrBytes,
});
const ADAPTER = path.join(__dirname, 'adapter.py');
const FIXTURES = path.join(__dirname, 'fixtures');
const MAX_DISK_ENTRIES = 10000;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

class RunnerError extends Error {
  constructor(code, message) { super(message); this.name = 'RunnerError'; this.code = code; }
}
function refuse(code, message) { throw new RunnerError(code, message); }
function limitsFor(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) refuse('LIMITS', 'Expected limit object');
  const limits = { ...RUNNER_DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value <= 0) refuse('LIMITS', 'Unknown or nonpositive limit');
    if (key === 'sampleIntervalMs' && value !== limits[key]) refuse('LIMITS', 'Wave 1 keeps the one-second sampling interval');
    const minimum = key.startsWith('min') || key === 'sampleIntervalMs';
    if (minimum ? value < limits[key] : value > limits[key]) refuse('LIMITS', 'Limit would weaken the Wave 1 budget');
    limits[key] = value;
  }
  return Object.freeze(limits);
}
function checkOptions(options, allowed) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) refuse('OPTIONS', 'Expected options object');
  for (const key of Object.keys(options)) if (!allowed.includes(key)) refuse('OPTIONS', `Unsupported runner option: ${key}`);
  if (options.sampler !== undefined && typeof options.sampler !== 'function') refuse('OPTIONS', 'sampler must be a function');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) refuse('OPTIONS', 'signal must be an AbortSignal');
}

// A fresh allowlist, never a filtered spread of process.env. No inherited GMAX,
// proxy, Python/Node injection, credential, model-location, or service variables.
function childEnvironment(root) {
  const home = path.join(root, 'home');
  const cache = path.join(root, 'cache');
  return {
    PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    HOME: home, GMAX_HOME: path.join(root, 'gmax'),
    XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    HF_HOME: path.join(cache, 'huggingface'), HF_HUB_CACHE: path.join(cache, 'huggingface', 'hub'),
    TRANSFORMERS_CACHE: path.join(cache, 'transformers'), TORCH_HOME: path.join(cache, 'torch'),
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', TOKENIZERS_PARALLELISM: 'false',
    OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
    // An empty device mask and no MPS fallback prevent accidental backend expansion.
    CUDA_VISIBLE_DEVICES: '', HIP_VISIBLE_DEVICES: '', PYTORCH_ENABLE_MPS_FALLBACK: '0',
  };
}

async function commandOutput(command, args) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8', timeout: 1500, maxBuffer: 2 * MiB,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    if (result.stderr.trim()) refuse('SAMPLING', 'Host measurement emitted diagnostics');
    return result.stdout;
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    refuse('SAMPLING', 'Required host measurement unavailable');
  }
}
function cpuSeconds(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) refuse('SAMPLING', 'Malformed process CPU time');
  // Darwin uses cumulative minutes (e.g. 130:55.44); Linux may use H:MM:SS
  // or D-HH:MM:SS. Minutes are bounded only when an hour field is present.
  if ((match[2] !== undefined && Number(match[3]) >= 60) || Number(match[4]) >= 60 || (match[1] && (match[2] === undefined || Number(match[2]) >= 24))) refuse('SAMPLING', 'Out-of-range process CPU time');
  const value = Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
  if (!Number.isFinite(value)) refuse('SAMPLING', 'Nonfinite process CPU time');
  return value;
}
async function processTable() {
  const output = await commandOutput('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,rss=,time=,stat=']);
  const rows = output.trim().split('\n').filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (!match) refuse('SAMPLING', 'Malformed process inventory');
    const row = { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), rssBytes: Number(match[4]) * 1024, cpuSeconds: cpuSeconds(match[5]), zombie: match[6].startsWith('Z') };
    if (!Object.values(row).every((v) => typeof v === 'boolean' || Number.isFinite(v))) refuse('SAMPLING', 'Nonfinite process inventory');
    return row;
  });
  return rows;
}
async function diskBytes(root) {
  let entries = 0;
  let bytes = 0;
  const start = performance.now();
  async function walk(current) {
    if (++entries > MAX_DISK_ENTRIES || performance.now() - start > 1000) refuse('SAMPLING', 'Experiment disk scan budget exceeded');
    let stat;
    try { stat = await fsp.lstat(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    // Count allocated blocks, including symlinks themselves; never follow links.
    if (!Number.isFinite(stat.blocks) || stat.blocks < 0) refuse('SAMPLING', 'Disk allocation unavailable');
    bytes += stat.blocks * 512;
    if (!Number.isSafeInteger(bytes)) refuse('SAMPLING', 'Invalid disk allocation');
    if (stat.isDirectory()) for (const name of await fsp.readdir(current)) await walk(path.join(current, name));
  }
  await walk(root);
  return bytes;
}
function parseLinuxMemory(text) {
  function field(name) {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(text);
    if (!match) refuse('SAMPLING', 'Required Linux memory field unavailable');
    return Number(match[1]) * 1024;
  }
  const totalSwap = field('SwapTotal');
  const freeSwap = field('SwapFree');
  if (freeSwap > totalSwap) refuse('SAMPLING', 'Invalid Linux swap reading');
  return { hostAvailableMemoryBytes: field('MemAvailable'), swapUsedBytes: totalSwap - freeSwap };
}
async function hostMemory(platform = process.platform) {
  if (platform === 'linux') {
    const [mem, pressure] = await Promise.all([fsp.readFile('/proc/meminfo', 'utf8'), fsp.readFile('/proc/pressure/memory', 'utf8')]);
    const full = /^full avg10=(\d+(?:\.\d+)?) /m.exec(pressure);
    const some = /^some avg10=(\d+(?:\.\d+)?) /m.exec(pressure);
    if (!full || !some) refuse('SAMPLING', 'Linux memory pressure unavailable');
    return { ...parseLinuxMemory(mem), memoryPressure: Number(full[1]) === 0 && Number(some[1]) === 0 ? 'normal' : 'warning' };
  }
  if (platform === 'darwin') {
    const [vm, swap, pressure] = await Promise.all([
      commandOutput('/usr/bin/vm_stat', []), commandOutput('/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
      commandOutput('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    ]);
    const pageMatch = /page size of (\d+) bytes/.exec(vm);
    const swapMatch = /used\s*=\s*(\d+(?:\.\d+)?)([KMG])/.exec(swap);
    if (!pageMatch || !swapMatch || !/^[124]\s*$/.test(pressure)) refuse('SAMPLING', 'macOS memory reading unavailable');
    let pages = 0;
    for (const label of ['free', 'inactive', 'speculative']) {
      const match = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.$`, 'm').exec(vm);
      if (!match) refuse('SAMPLING', 'macOS memory page field unavailable');
      pages += Number(match[1]);
    }
    return {
      hostAvailableMemoryBytes: pages * Number(pageMatch[1]),
      swapUsedBytes: Number(swapMatch[1]) * ({ K: 1024, M: MiB, G: GiB })[swapMatch[2]],
      memoryPressure: Number(pressure.trim()) === 1 ? 'normal' : 'warning',
    };
  }
  refuse('SAMPLING', 'Only macOS and Linux host sampling is supported');
}
async function sampleHost({ processGroupId, evaluationRoot }) {
  const [memory, disk, statfs, rows] = await Promise.all([
    hostMemory(), diskBytes(evaluationRoot), fsp.statfs(evaluationRoot), processTable(),
  ]);
  const owned = processGroupId === null ? [] : rows.filter((row) => row.pgid === processGroupId && !row.zombie);
  return {
    ...memory, experimentDiskBytes: disk, hostFreeDiskBytes: statfs.bavail * statfs.bsize,
    ownedRssBytes: owned.reduce((sum, row) => sum + row.rssBytes, 0),
    ownedCpuSeconds: owned.reduce((sum, row) => sum + row.cpuSeconds, 0),
    ownedPids: owned.map((row) => row.pid),
  };
}
function validateSample(sample) {
  if (!sample || typeof sample !== 'object') refuse('SAMPLING', 'Missing sample');
  const copy = {};
  for (const key of ['experimentDiskBytes', 'hostFreeDiskBytes', 'ownedRssBytes', 'ownedCpuSeconds', 'hostAvailableMemoryBytes', 'swapUsedBytes']) {
    if (typeof sample[key] !== 'number' || !Number.isFinite(sample[key]) || sample[key] < 0) refuse('SAMPLING', 'Missing, nonfinite or negative resource reading');
    copy[key] = sample[key];
  }
  if (!['normal', 'warning'].includes(sample.memoryPressure)) refuse('SAMPLING', 'Memory pressure reading unavailable');
  if (!Array.isArray(sample.ownedPids) || sample.ownedPids.length > MAX_DISK_ENTRIES || !sample.ownedPids.every((p) => Number.isSafeInteger(p) && p > 1)) refuse('SAMPLING', 'Invalid owned-process reading');
  copy.memoryPressure = sample.memoryPressure;
  copy.ownedPids = [...new Set(sample.ownedPids)];
  return copy;
}
function enforceSample(sample, baselineSwap, limits) {
  if (sample.memoryPressure !== 'normal') refuse('RESOURCE_MEMORY_PRESSURE', 'Host reports memory pressure');
  if (sample.hostAvailableMemoryBytes < limits.minHostAvailableMemoryBytes) refuse('RESOURCE_HOST_MEMORY', 'Host available memory below minimum');
  if (sample.hostFreeDiskBytes < limits.minHostFreeDiskBytes) refuse('RESOURCE_HOST_DISK', 'Host free disk below minimum');
  if (sample.ownedRssBytes > limits.maxOwnedRssBytes) refuse('RESOURCE_RSS', 'Owned aggregate RSS exceeds ceiling');
  if (sample.experimentDiskBytes > limits.maxExperimentDiskBytes) refuse('RESOURCE_DISK', 'Experiment disk exceeds ceiling');
  if (sample.swapUsedBytes - baselineSwap > limits.maxSwapGrowthBytes) refuse('RESOURCE_SWAP', 'Host swap growth exceeds ceiling');
}
function parseObjectFrame(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('PROTOCOL', 'Response must be a JSON object');
    return value;
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    refuse('PROTOCOL', 'Malformed UTF-8 JSON response');
  }
}

function validateValidationResponse(response, request) {
  try { return validateResponse(response, request); }
  catch (error) {
    if (error instanceof ProtocolError) refuse('PROTOCOL', 'Parent contract rejected validation response');
    throw error;
  }
}

async function cleanupGroup(pid, manifest) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) refuse('CLEANUP', 'Invalid owned process group');
  const live = async () => {
    try {
      const rows = (await processTable()).filter((row) => row.pgid === pid);
      manifest.ownership.observedPids = [...new Set([...manifest.ownership.observedPids, ...rows.map((row) => row.pid)])];
      manifest.cleanup.zombiePids = rows.filter((row) => row.zombie).map((row) => row.pid);
      manifest.cleanup.verificationSource = 'process-inventory';
      return rows.filter((row) => !row.zombie);
    } catch {
      // Losing the resource inventory must never prevent terminating the group
      // that this controller created. kill(0) only probes that exact owned PGID.
      manifest.cleanup.inventoryUnavailable = true;
      try { process.kill(-pid, 0); return ['owned-group-still-present']; }
      catch (error) {
        if (error.code !== 'ESRCH') throw error;
        manifest.cleanup.verificationSource = 'owned-group-absent';
        return [];
      }
    }
  };
  const signal = (name) => {
    try { process.kill(-pid, name); manifest.cleanup.signals.push(name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  if ((await live()).length) {
    signal('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 150));
    if ((await live()).length) signal('SIGKILL');
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!(await live()).length) { manifest.cleanup.noLiveOwnedProcesses = true; return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  refuse('CLEANUP', 'Owned process group remains live after bounded cleanup');
}

async function executeChild({ command, args, input, limits, sampler, signal, mode, validateResponse }) {
  if (!['darwin', 'linux'].includes(process.platform)) refuse('PLATFORM', 'Owned POSIX process groups required');
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > limits.maxInputBytes) refuse('INPUT_LIMIT', 'Input bytes outside budget');
  // Do not let inherited TMPDIR/TMP/TEMP redirect writes into a primary home,
  // store, or sharedRoot. The base is the platform's fixed system temp directory.
  const tempBase = await fsp.realpath(process.platform === 'darwin' ? '/private/tmp' : '/tmp');
  const evaluationRoot = await fsp.realpath(await fsp.mkdtemp(path.join(tempBase, 'gmax-colbert-wave1-')));
  await fsp.chmod(evaluationRoot, 0o700);
  const env = childEnvironment(evaluationRoot);
  for (const dir of new Set([path.join(evaluationRoot, 'work'), ...Object.values(env).filter((value) => value.startsWith(evaluationRoot + path.sep))])) await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const requestPath = path.join(evaluationRoot, 'request.jsonl');
  const responsePath = path.join(evaluationRoot, 'response.jsonl');
  const manifestPath = path.join(evaluationRoot, 'manifest.json');
  await fsp.writeFile(requestPath, input, { mode: 0o600, flag: 'wx' });
  const started = performance.now();
  const manifest = {
    schemaVersion: 1, operation: mode, inferencePerformed: mode === 'cpu-mps-smoke' ? null : false,
    startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + limits.deadlineMs).toISOString(),
    deadlineScope: 'Admission and child execution; bounded cleanup may extend total wall time.',
    argv: [command, ...args], cwd: path.join(evaluationRoot, 'work'), evaluationRoot, limits,
    environment: env, request: { path: requestPath, bytes: input.length, sha256: hash(input) },
    response: { path: responsePath, bytes: 0, sha256: hash(Buffer.alloc(0)), complete: false },
    stderr: { bytes: 0, sha256: hash(Buffer.alloc(0)), retainedBytes: 0 },
    metricUnits: { '*Bytes': 'bytes', ownedCpuSeconds: 'seconds', elapsedMs: 'milliseconds', sampleIntervalMs: 'milliseconds' },
    sampling: {
      source: sampler === sampleHost ? 'host-builtins' : sampler.source || 'injected-test-sampler', intervalMs: limits.sampleIntervalMs,
      limitations: [
        'Periodic snapshots are screening guards, not OS resource enforcement; peaks between samples can be missed.',
        'Short children can exit before the first owned RSS/CPU sample; exited process CPU is not accumulated.',
        'RSS sums may double-count shared pages; GPU allocations are not measured in Wave 1.',
        'Swap and host pressure are host-wide and cannot establish experiment causality.',
        'macOS available memory is free + inactive + speculative pages, an estimate; Linux uses MemAvailable.',
        'macOS swapusage reports rounded human-readable quantities; conversion to bytes retains that limited precision.',
        'Allocated disk blocks cover this fresh evaluation root only, with symlinks not followed.',
        'Admission and periodic readings only; cleanup inventory is separate from resource sampling.',
        'Controller SIGKILL/crash and descendants that escape the owned session are outside stdlib process-group guarantees.',
        ...(sampler.limitations || []),
      ],
    },
    isolation: { environmentAllowlist: true, privateDirectories: true, filesystemSandbox: false, networkSandbox: false, note: 'Fixed validation adapter, owned model-free fixture or explicitly selected Mac smoke program; offline flags are not network access control.' },
    ownership: { controllerPid: process.pid, detachedNewSession: true, processGroupId: null, childPid: null, observedPids: [] },
    cleanup: { signals: [], noLiveOwnedProcesses: true, zombiePids: [] }, samples: [],
    outcome: 'incomplete', code: null,
  };
  let child;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outputBytes = 0;
  let stderrBytes = 0;
  let outputHash = crypto.createHash('sha256');
  let stderrHash = crypto.createHash('sha256');
  let response;
  let failure;
  let stop;
  let deadlineTimer;
  let periodicTimer;
  let exited;
  let lastSampleAt = -Infinity;
  let samplingClosed = false;
  let pendingSample;
  const fail = (error) => {
    if (!failure) failure = error instanceof RunnerError ? error : new RunnerError('CHILD_IO', 'Child or controller I/O failed');
    if (stop) stop();
  };
  const abort = () => fail(new RunnerError('ABORTED', 'Caller aborted owned child'));
  const sample = async () => {
    const elapsed = performance.now() - started;
    if (elapsed - lastSampleAt < limits.sampleIntervalMs) return;
    lastSampleAt = elapsed;
    let value;
    try { value = await sampler({ processGroupId: child?.pid || null, evaluationRoot }); }
    catch (error) { if (error instanceof RunnerError) throw error; refuse('SAMPLING', 'Required resource sampler unavailable'); }
    if (samplingClosed) return;
    const reading = validateSample(value);
    manifest.samples.push({ elapsedMs: elapsed, ...reading, swapGrowthBytes: Math.max(0, reading.swapUsedBytes - (manifest.samples[0]?.swapUsedBytes ?? reading.swapUsedBytes)) });
    if (manifest.samples.length > 1801) refuse('SAMPLING', 'Sample count exceeds budget');
    manifest.ownership.observedPids = [...new Set([...manifest.ownership.observedPids, ...reading.ownedPids])];
    enforceSample(reading, manifest.samples[0].swapUsedBytes, limits);
  };
  try {
    const interruption = new Promise((resolve) => { stop = resolve; });
    deadlineTimer = setTimeout(() => fail(new RunnerError('TIMEOUT', 'Wave 1 child deadline exceeded')), limits.deadlineMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    await Promise.race([sample(), interruption]);
    if (failure) throw failure;
    child = spawn(command, args, { cwd: manifest.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    manifest.ownership.childPid = child.pid || null;
    manifest.ownership.processGroupId = child.pid || null;
    manifest.cleanup.noLiveOwnedProcesses = !child.pid;
    if (child.pid) manifest.ownership.observedPids.push(child.pid);
    child.on('error', () => fail(new RunnerError('SPAWN', 'Validation child could not start')));
    exited = new Promise((resolve) => child.once('exit', (code, childSignal) => { manifest.childExit = { code, signal: childSignal }; resolve(); }));
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.stdin.on('error', () => fail(new RunnerError('CHILD_IO', 'Child input pipe failed')));
    child.stdout.on('error', () => fail(new RunnerError('CHILD_IO', 'Child output pipe failed')));
    child.stderr.on('error', () => fail(new RunnerError('CHILD_IO', 'Child error pipe failed')));
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length; outputHash.update(chunk);
      if (outputBytes > limits.maxStdoutBytes) { fail(new RunnerError('STDOUT_LIMIT', 'Child stdout exceeds budget')); child.stdout.pause(); return; }
      stdout = Buffer.concat([stdout, chunk]);
      const newline = stdout.indexOf(10);
      if (newline !== -1) {
        if (newline !== stdout.length - 1) { fail(new RunnerError('PROTOCOL', 'Extra response frame or trailing bytes')); return; }
        try { response = validateResponse(stdout); } catch { fail(new RunnerError('PROTOCOL', 'Invalid validation response')); }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length; stderrHash.update(chunk);
      const remaining = limits.maxStderrBytes - stderr.length;
      if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      if (stderrBytes > limits.maxStderrBytes) { fail(new RunnerError('STDERR_LIMIT', 'Child stderr exceeds budget')); child.stderr.pause(); }
    });
    child.stdin.end(input);
    async function periodic() {
      // The root can exit while same-group descendants still hold the pipes.
      // Keep all resource guards active until the execution wait ends.
      if (failure || samplingClosed) return;
      try { pendingSample = sample(); await pendingSample; } catch (error) { if (!samplingClosed) fail(error); return; }
      if (!failure && !samplingClosed) periodicTimer = setTimeout(periodic, limits.sampleIntervalMs);
    }
    periodicTimer = setTimeout(periodic, Math.max(1, limits.sampleIntervalMs - (performance.now() - started - lastSampleAt)));
    // Root exit alone is insufficient: inherited stdout may remain open in descendants.
    await Promise.race([closed, interruption]);
    if (pendingSample && !failure) await Promise.race([pendingSample, interruption]);
    if (failure) throw failure;
    if (manifest.childExit?.code !== 0 || manifest.childExit?.signal) refuse('CHILD_EXIT', 'Validation child exited unsuccessfully');
    if (!stdout.length || stdout[stdout.length - 1] !== 10 || stdout.indexOf(10) !== stdout.length - 1) refuse('PROTOCOL', 'Expected exactly one terminated response frame');
    response = validateResponse(stdout);
    if (response.ok === false) refuse('ADAPTER_REFUSAL', 'Validation adapter refused request');
    manifest.outcome = mode === 'cpu-mps-smoke' ? 'completed' : mode === 'mac-smoke-readiness' ? 'ready' : 'validated';
    manifest.code = 'OK';
    manifest.response.complete = true;
  } catch (error) {
    failure = failure || (error instanceof RunnerError ? error : new RunnerError('CONTROLLER', 'Evaluation controller refused execution'));
    manifest.outcome = 'refused'; manifest.code = failure.code;
  } finally {
    const cleanupStarted = performance.now();
    samplingClosed = true;
    clearTimeout(deadlineTimer); clearTimeout(periodicTimer);
    signal?.removeEventListener('abort', abort);
    if (child?.pid) {
      try { await cleanupGroup(child.pid, manifest); }
      catch { manifest.outcome = 'refused'; manifest.code = 'CLEANUP'; manifest.cleanup.noLiveOwnedProcesses = false; }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      // Reap the directly owned child; detached descendants can be reaped only by the OS.
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
    manifest.elapsedMs = performance.now() - started;
    manifest.cleanup.elapsedMs = performance.now() - cleanupStarted;
    manifest.response.bytes = outputBytes; manifest.response.retainedBytes = stdout.length;
    manifest.response.sha256 = outputHash.digest('hex');
    manifest.stderr.bytes = stderrBytes; manifest.stderr.retainedBytes = stderr.length; manifest.stderr.sha256 = stderrHash.digest('hex');
    manifest.response.hashScope = 'all observed stdout bytes; stream may be truncated by refusal';
    if (mode === 'cpu-mps-smoke') manifest.inferencePerformed = !child?.pid ? false :
      typeof response?.inferencePerformed === 'boolean' ? response.inferencePerformed : null;
    manifest.stderr.hashScope = 'all observed stderr bytes; stream may be truncated by refusal';
    if (manifest.code !== 'OK') manifest.refusal = { code: manifest.code, message: manifest.code === failure?.code ? failure.message : 'Owned process cleanup could not be verified' };
    await fsp.writeFile(responsePath, stdout, { mode: 0o600, flag: 'wx' });
    await fsp.writeFile(path.join(evaluationRoot, 'stderr.bin'), stderr, { mode: 0o600, flag: 'wx' });
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return { ok: manifest.code === 'OK', code: manifest.code, response, manifest, manifestPath, evaluationRoot, stderr: stderr.toString('utf8') };
}

// Deliberately narrower than spawn(): this export accepts only owned .cjs fixture
// entrypoints and the current Node executable. It cannot substitute an adapter.
async function runBoundedChild(options) {
  checkOptions(options, ['command', 'args', 'input', 'limits', 'sampler', 'signal', 'syntheticFixture']);
  if (options.syntheticFixture !== true || options.command !== process.execPath || !Array.isArray(options.args) || !options.args.length) refuse('FIXTURE_ONLY', 'Explicit current-Node owned fixture command required');
  if (options.args.length > 16 || !options.args.every((arg) => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'))) refuse('FIXTURE_ONLY', 'Invalid fixture argv');
  const target = options.args[0];
  if (!path.isAbsolute(target) || path.dirname(target) !== FIXTURES || path.extname(target) !== '.cjs' || await fsp.realpath(target) !== target) refuse('FIXTURE_ONLY', 'Command must name an owned model-free fixture');
  const limits = limitsFor(options.limits);
  const input = options.input === undefined ? Buffer.from('{}\n') : Buffer.from(options.input);
  return executeChild({ command: options.command, args: [...options.args], input, limits, sampler: options.sampler || sampleHost, signal: options.signal, mode: 'synthetic-fixture', validateResponse: (bytes) => parseObjectFrame(bytes) });
}

async function pythonExecutable() {
  for (const executable of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', '/bin/python3']) {
    try { await fsp.access(executable, fs.constants.X_OK); return executable; } catch { /* No install or PATH fallback. */ }
  }
  refuse('PYTHON_UNAVAILABLE', 'Existing Python 3 executable required; runner never installs one');
}
async function runValidation(request, options = {}) {
  checkOptions(options, ['limits', 'sampler', 'signal']);
  const limits = limitsFor(options.limits);
  // Parent-owned protocol implementation is loaded only for the adapter route.
  const { validateRequest, encodeLine, parseLine } = require('./contract.cjs');
  const validated = validateRequest(request);
  if (validated.operation !== 'validate') refuse('INFERENCE_DISABLED', 'Wave 1 permits validation only');
  const input = Buffer.from(encodeLine(validated));
  const command = await pythonExecutable();
  return executeChild({ command, args: ['-I', '-B', '-S', ADAPTER], input, limits, sampler: options.sampler || sampleHost, signal: options.signal, mode: 'validate', validateResponse: (bytes) => validateValidationResponse(parseLine(bytes), validated) });
}

async function runMacSmoke(root, options = {}) {
  checkOptions(options, ['execute', 'signal', 'compareOnnx', 'paired', 'labelScreen']);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') refuse('PLATFORM', 'This experiment requires Apple Silicon macOS');
  if (options.execute !== undefined && typeof options.execute !== 'boolean') refuse('OPTIONS', 'Execution must be explicit');
  root = await fsp.realpath(root);
  const python = path.join(root, 'venv', 'bin', 'python');
  await fsp.access(python, fs.constants.X_OK);
  const execute = options.execute === true;
  if (options.compareOnnx !== undefined && typeof options.compareOnnx !== 'boolean') refuse('OPTIONS', 'ONNX comparison must be explicit');
  if (options.compareOnnx && !execute) refuse('OPTIONS', 'ONNX comparison requires execution');
  if (options.paired !== undefined && typeof options.paired !== 'boolean') refuse('OPTIONS', 'Paired mode must be explicit');
  if (options.paired && !options.compareOnnx) refuse('OPTIONS', 'Paired mode requires ONNX comparison');
  if (options.labelScreen !== undefined && typeof options.labelScreen !== 'boolean') refuse('OPTIONS', 'Label screen must be explicit');
  if (options.labelScreen && (!execute || options.paired || options.compareOnnx)) refuse('OPTIONS', 'Label screen requires separate explicit execution');
  const limits = limitsFor({ deadlineMs: execute ? 30 * 60 * 1000 : 60 * 1000 });
  const footprint = await execFileAsync('/usr/bin/du', ['-sk', root], { encoding: 'utf8', timeout: 10000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
  const match = /^(\d+)\s/.exec(footprint.stdout);
  if (!match || footprint.stderr.trim()) refuse('SAMPLING', 'Prepared runtime disk footprint unavailable');
  let preparedDiskBytes = Number(match[1]) * 1024;
  if (options.labelScreen) {
    for (const name of ['embeddinggemma2-eval-20261021-mac-01/colbert-features.jsonl', 'colbert-backend-wave1-20261023/bundle-v4/chunks.jsonl']) {
      preparedDiskBytes += (await fsp.stat(path.join(root, '..', name))).size;
    }
  }
  if (!Number.isSafeInteger(preparedDiskBytes)) refuse('SAMPLING', 'Invalid prepared disk footprint');
  // Include prepared runtime/cache/model bytes as well as the fresh child root.
  const sampler = async context => {
    const sample = await sampleHost(context);
    sample.experimentDiskBytes += preparedDiskBytes;
    return sample;
  };
  sampler.source = 'host-builtins-with-prepared-disk-snapshot';
  sampler.limitations = ['Prepared runtime/model/cache allocation is a one-time du snapshot; those inputs remain unchanged during execution. Fresh child-root allocation is sampled live.'];
  const command = options.labelScreen ? process.execPath : python;
  const args = options.labelScreen ? [path.join(__dirname, 'label-screen.cjs'), '--child', root] : ['-I', '-B', path.join(__dirname, 'mac-smoke.py'), options.paired ? '--compare-paired' : options.compareOnnx ? '--compare-onnx' : execute ? '--execute' : '--ready', '--root', root,
    '--node', process.execPath];
  return executeChild({ command, args,
    input: Buffer.from('{}\n'), limits, sampler, signal: options.signal,
    mode: execute ? 'cpu-mps-smoke' : 'mac-smoke-readiness',
    validateResponse: bytes => {
      const response = parseObjectFrame(bytes);
      if (typeof response.ok !== 'boolean' || typeof response.inferencePerformed !== 'boolean' || (!execute && response.inferencePerformed)) refuse('PROTOCOL', 'Invalid smoke response');
      return response;
    } });
}

const HELP = `Wave 1 validation-only runner (Node stdlib; no model execution).
Usage: node scripts/colbert-eval/runner.cjs --request /path/to/request.json [--deadline-ms 30000]
       node scripts/colbert-eval/runner.cjs --help

The payload is one schemaVersion-1 validate request from CONTRACT.md, as a JSON
object (optional terminal newline), at most 4 MiB. No infer operation, command,
model-path, environment override, runtime installation or network fallback exists.
Example payload: scripts/colbert-eval/fixtures/synthetic-validate-request.json
Its revision/artifact hashes are synthetic; validation does not verify artifacts.
Default child: an existing local Python 3, -I -B -S, fixed adapter.py over stdio.
Fresh private directories are created beneath the OS temporary directory.
stdout: one result JSON object naming manifestPath and evaluationRoot; exit 0
only on validated + checked cleanup, otherwise exit 1. Request/response JSONL,
bounded stderr.bin and manifest.json remain there for parent-owned inspection.
All deadlines are positive and <=1800000 ms. Resource floors cannot be lowered;
ceilings may be reduced. Host sampling fails closed on missing/invalid readings
or pressure warnings. Offline flags/environment isolation are not an OS sandbox.
Tests: node --test scripts/colbert-eval/test-runner.cjs
`;
async function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { process.stdout.write(HELP); return; }
  let requestPath;
  const limits = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--request' && !requestPath && argv[i + 1]) requestPath = argv[++i];
    else if (argv[i] === '--deadline-ms' && limits.deadlineMs === undefined && /^\d+$/.test(argv[i + 1] || '')) limits.deadlineMs = Number(argv[++i]);
    else refuse('CLI', 'Unknown, duplicate or missing CLI argument; use --help');
  }
  if (!requestPath) refuse('CLI', '--request payload path is required');
  limitsFor(limits);
  const file = await fsp.open(requestPath, fs.constants.O_RDONLY);
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > RUNNER_DEFAULT_LIMITS.maxInputBytes) refuse('INPUT_LIMIT', 'Payload file outside budget');
    bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) refuse('INPUT_LIMIT', 'Payload changed during bounded read');
    bytes = bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
  const request = parseObjectFrame(bytes);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let result;
  try { result = await runValidation(request, { limits, signal: controller.signal }); }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  process.stdout.write(JSON.stringify({ ok: result.ok, code: result.code, manifestPath: result.manifestPath, evaluationRoot: result.evaluationRoot }) + '\n');
  if (!result.ok) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(JSON.stringify({ ok: false, code: error.code || 'RUNNER', message: 'Wave 1 validation refused; use --help and inspect the bounded payload/budget.' }) + '\n');
  process.exitCode = 1;
});
module.exports = { runValidation, runBoundedChild, runMacSmoke, RunnerError, RUNNER_DEFAULT_LIMITS, limitsFor, sampleHost, validateSample, validateValidationResponse, parseLinuxMemory, cpuSeconds, HELP };
