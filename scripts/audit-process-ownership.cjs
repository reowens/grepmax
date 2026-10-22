// Exact-package process-control regression. All process/filesystem dependencies
// are simulated; no OS discovery, signals, daemon, model or native store is used.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
function load(relative, mocks, processMock) {
  const exports = {};
  const filename = path.join(root, relative);
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    exports, Promise, Set, Map,
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
      return mocks[name];
    },
    process: processMock,
    console: { log() {}, error() {} },
    setTimeout: () => ({ unref() {} }),
    clearTimeout() {}, clearInterval() {},
  }, { filename, timeout: 1000 });
  return exports;
}
(async () => {
  for (const withDaemon of [true, false]) {
    const kills = [], discovery = [];
    const { ProcessManager } = load("dist/lib/daemon/process-manager.js", {
      "node:child_process": { execSync(command) {
        discovery.push(command);
        if (command === 'pgrep -x "gmax-daemon"') return withDaemon ? "910001" : "";
        if (command === 'pgrep -x "gmax-worker"') return "910002";
        throw Error("Unexpected command");
      } },
      "node:fs": { lstatSync() { throw Object.assign(Error("absent"), { code: "ENOENT" }); } },
      "../../config": { PATHS: { daemonPidFile: "/fixture/daemon.pid", daemonDrainingFile: "/fixture/daemon.draining" } },
      "../utils/daemon-client": { isDaemonDraining: () => false, waitForDaemonDrain: async () => false, isDaemonHeartbeatFresh: () => false, isDaemonRunning: async () => false },
      "../utils/logger": { log() {} },
      "../utils/process": { killProcess: async pid => kills.push(pid) },
    }, { pid: 910000, kill() { throw Error("Unexpected OS signal"); }, exit() { throw Error("Unexpected exit"); } });
    const manager = new ProcessManager({ getShuttingDown: () => false });
    await (manager.assertStartupAvailable || manager.killStaleProcesses).call(manager);
    assert.deepEqual(kills, [], "Foreign processes must never be termination targets");
    assert.deepEqual(discovery, [], "Startup must not discover processes globally");
  }
  // Exercise the CLI failure sequence with the full compiled Daemon class:
  // a rejected start is always followed by shutdown for partial-start cleanup.
  for (const kind of ["healthy", "draining", "malformed", "permission", "late-draining", "late-unknown", "late-malformed", "late-watcher-live", "late-watcher-unknown", "late-watcher-malformed", "listen-watcher-live", "listen-watcher-unknown", "listen-watcher-malformed"]) {
    const watcherCase = kind.includes("-watcher-");
    const listenWatcher = kind.startsWith("listen-");
    const late = kind.startsWith("late-") || listenWatcher;
    const watchers = [];
    const watcher = { pid: kind.endsWith("-malformed") ? NaN : 910002, projectRoot: "/fixture/repo" };
    const arrive = () => watchers.push(watcher);
    const PATHS = { globalRoot: "/fixture", cacheDir: "/fixture/cache", lancedbDir: "/fixture/lance", daemonPidFile: "/fixture/daemon.pid", daemonDrainingFile: "/fixture/daemon.draining", daemonSocket: "/fixture/daemon.sock", daemonLockFile: "/fixture/daemon.lock" };
    const markers = new Map([[kind === "draining" ? PATHS.daemonDrainingFile : PATHS.daemonPidFile,
      kind === "draining" ? JSON.stringify({ pid: 910001, ts: 1 }) : kind === "malformed" ? "bad-pid" : "910001"],
      [PATHS.daemonSocket, "predecessor-socket"]]);
    if (late) markers.clear();
    let before = [...markers], releases = 0;
    const mutations = [], probes = [];
    const fakeFs = {
      lstatSync(file) {
        if (kind === "permission") throw Object.assign(Error("denied"), { code: "EACCES" });
        if (!markers.has(file)) throw Object.assign(Error("absent"), { code: "ENOENT" });
        return { isFile: () => true, isSymbolicLink: () => false };
      },
      readFileSync: file => markers.get(file),
      unlinkSync(file) { mutations.push(["unlink", file]); markers.delete(file); },
      mkdirSync() { assert.ok(late, "Unexpected mkdir"); }, chmodSync() {},
      writeFileSync(file, value) {
        assert.ok(late && (file === PATHS.daemonLockFile || (listenWatcher && file === PATHS.daemonPidFile)), "Unexpected control publication");
        if (file === PATHS.daemonPidFile) markers.set(file, value);
      },
    };
    const processMock = { env: { VITEST: "true" }, pid: 910000,
      kill(pid, signal) {
        assert.equal(signal, 0); probes.push(pid);
        if (kind.endsWith("-unknown")) throw Object.assign(Error("denied"), { code: "EPERM" });
        return true;
      } };
    const client = {
      isDaemonDraining: () => kind === "draining" || late, waitForDaemonDrain: async () => false,
      writeDrainingMarker(pid) { mutations.push(["write-drain", pid]); markers.set(PATHS.daemonDrainingFile, JSON.stringify({ pid })); },
      clearDrainingMarker() { mutations.push(["clear-drain"]); markers.delete(PATHS.daemonDrainingFile); },
    };
    const { ProcessManager } = load("dist/lib/daemon/process-manager.js", {
      "node:fs": fakeFs, "node:child_process": {}, "../../config": { PATHS }, "../utils/daemon-client": client,
    }, processMock);
    // Internal modules unused on this path have inert exports. None are loaded
    // from the host; load() still rejects every unlisted dependency.
    const daemonCode = fs.readFileSync(path.join(root, "dist/lib/daemon/daemon.js"), "utf8");
    const mocks = {};
    for (const [, name] of daemonCode.matchAll(/require\("([^" ]+)"\)/g)) {
      assert.ok(name.startsWith(".") || ["node:fs", "node:net", "node:path", "proper-lockfile"].includes(name));
      mocks[name] = {};
    }
    const noop = () => {};
    Object.assign(mocks, {
      "node:fs": fakeFs, "node:path": path, "../../config": { PATHS, CONFIG: {} },
      "node:net": { createServer() {
        assert.ok(listenWatcher, "Refused startup reached socket publication");
        return { listening: true, on() {}, listen(_file, callback) { arrive(); callback(); }, close(callback) { callback?.(); } };
      } },
      "../index/index-config": { readGlobalConfig: () => ({}) },
      "../index/embedding-generation": { resolveEmbeddingGeneration: () => ({ vectorDim: 1 }) },
      "../store/vector-db": { VectorDB: class { constructor() { throw Error("Refused startup reached shared resource construction"); } } },
      "proper-lockfile": { lock: async () => {
        assert.ok(late, "Unexpected lock acquisition");
        if (watcherCase) { if (!listenWatcher) arrive(); }
        else markers.set(PATHS.daemonDrainingFile, kind === "late-malformed" ? "bad-json" : JSON.stringify({ pid: 910001, ts: 1 }));
        before = [...markers];
        return async () => { releases++; };
      } },
      "../utils/logger": { debug() {} },
      "../utils/async-semaphore": { AsyncSemaphore: class {} },
      "../utils/autostart": { daemonStartDeniedReason: () => null },
      "../utils/daemon-client": client,
      "../utils/host-guard-policy": { hostGuardPolicy: () => "critical-only" },
      "../utils/keyed-mutex": { KeyedMutex: class { async close() {} } },
      "../utils/operation-coordinator": { OperationCoordinator: class { async close() {} } },
      "../utils/resource-budget": { resourceBudget: { check: () => null } },
      "../utils/watcher-store": { listWatchers: () => [...watchers], unregisterDaemon: () => mutations.push(["unregister-daemon"]) },
      "../workers/pool": { isWorkerPoolInitialized: () => false },
      "./mlx-server-manager": { MlxServerManager: class { async stopMlxServer() {} } },
      "./process-manager": { ProcessManager },
      "./read-verbs": { registerGraphVerbs: noop }, "./rows-handler": { registerRowsVerbs: noop },
      "./vector-handler": { registerVectorVerbs: noop }, "./watch-leases": { WatchLeases: class {} },
      "./watcher-manager": { WatcherManager: class { async quiesceAll() {} } },
    });
    const { Daemon } = load("dist/lib/daemon/daemon.js", mocks, processMock);
    for (let attempt = 0; attempt < 2; attempt++) {
      const daemon = new Daemon();
      daemon.hostPressureDeniedReason = () => null;
      daemon.hasUnfinishedRebuild = () => false;
      await assert.rejects(() => daemon.start(), /startup refused/);
      await daemon.shutdown();
      assert.deepEqual([...markers], before, `${kind}: predecessor evidence must survive caller cleanup`);
      if (!listenWatcher) assert.deepEqual(mutations, [], `${kind}: refused start owns no shared state`);
      if (watcherCase) assert.deepEqual(watchers, [watcher], `${kind}: registry evidence must survive cleanup`);
    }
    if (late) assert.equal(releases, 1, "Refused post-lock start must release its own lock");
  }
  const { restartDaemon } = load("dist/lib/utils/daemon-restart.js", {}, {});
  for (const shutdownOk of [false, true]) {
    let clock = 0, oldAlive = true, current = { pid: 910001 }, stopAt = Infinity;
    const kills = [], starts = [];
    const deps = {
      ping: async () => current ? { ok: true, ready: true, ...current } : { ok: false },
      status: async () => ({ ok: true }),
      requestShutdown: async () => {
        if (shutdownOk) { current = null; stopAt = 300; }
        return { ok: shutdownOk };
      },
      liveDaemonPidFromFiles: () => oldAlive ? 910001 : null,
      isAlive: pid => pid === 910001 ? oldAlive : current?.pid === pid,
      terminate: pid => { kills.push(pid); oldAlive = false; current = null; },
      spawn: async () => {
        assert.equal(oldAlive, false, "Must wait for predecessor exit");
        starts.push(910003); current = { pid: 910003 }; return 910003;
      },
      sleep: async ms => { clock += ms; if (clock >= stopAt) oldAlive = false; },
      now: () => clock,
    };
    const result = await restartDaemon(deps, { exitTimeoutMs: 1000, pollMs: 100 });
    assert.deepEqual(kills, []);
    assert.equal(result.ok, shutdownOk);
    assert.deepEqual(starts, shutdownOk ? [910003] : []);
    if (shutdownOk) assert.ok(clock >= 300);
  }
  const deletes = [], probes = [];
  const stale = { pid: 910002, projectRoot: "/fixture/repo", startTime: 1, lastHeartbeat: 1 };
  const { listWatchers } = load("dist/lib/utils/watcher-store.js", {
    "node:fs": { mkdirSync() {} },
    "node:path": path,
    "lmdb": { open: () => ({ getRange: () => [{ key: stale.projectRoot, value: stale }], remove: key => deletes.push(key) }) },
    "../../config": { PATHS: { cacheDir: "/fixture/cache" } },
  }, { kill: (...args) => probes.push(args) });
  assert.deepEqual(JSON.parse(JSON.stringify(listWatchers({ includeStale: true }))), [stale]);
  assert.deepEqual(deletes, []);
  assert.deepEqual(probes, []);
  console.log("Packaged process ownership: foreign daemon/worker preserved; cooperative drain/refusal; registry evidence and refused-start cleanup preserved; zero real signals");
})().catch(error => { console.error(error); process.exitCode = 1; });
