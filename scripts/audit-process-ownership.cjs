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
    console: { log() {} },
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
  console.log("Packaged process ownership: foreign daemon/worker preserved; cooperative drain/refusal; registry evidence preserved; zero real signals");
})().catch(error => { console.error(error); process.exitCode = 1; });
