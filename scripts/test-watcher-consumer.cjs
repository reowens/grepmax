// Tiny isolated native-store qualification. Never loads an embedding model.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {createRequire} = require("node:module");
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gmax-watcher-consumer-")));
process.env.HOME = path.join(temp, "home");
process.env.GMAX_HOME = path.join(temp, "data");
fs.mkdirSync(process.env.HOME);
const packageRoot = path.resolve(process.argv[2] ?? path.join(__dirname, ".."));
const packageRequire = createRequire(path.join(packageRoot, "package.json"));
const load = file => require(path.join(packageRoot, "dist", file));
// A regression that starts a worker or model fails instead of allocating it.
const childProcess = require("node:child_process");
childProcess.spawn = childProcess.fork = () => { throw new Error("Watcher fixture attempted to start a subprocess"); };
const parcel = packageRequire("@parcel/watcher");
const nativeSubscribe = parcel.subscribe.bind(parcel);
let delivery = true, callback, subscriptions = 0;
parcel.subscribe = async (root, cb, options) => {
  subscriptions++;
  callback = cb;
  return nativeSubscribe(root, (error, events) => { if (delivery) cb(error, events); }, options);
};
let pool;
load("lib/workers/pool.js").getWorkerPool = () => pool;
const {VectorDB} = load("lib/store/vector-db.js");
const {MetaCache} = load("lib/store/meta-cache.js");
const {WatcherManager} = load("lib/daemon/watcher-manager.js");
const {startWatcher} = load("lib/index/watcher.js");
const {computeContentHash} = load("lib/utils/file-utils.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { await check(); return; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`${label}: ${last?.stack}`);
}
async function qualify(mode) {
  const root = path.join(temp, mode), store = path.join(temp, `${mode}-store`);
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "artifacts"));
  const absolute = name => path.join(root, name);
  const write = (name, body) => fs.writeFileSync(absolute(name), body);
  write(".gmaxignore", "/artifacts/\n");
  for (const name of ["changed.ts", "removed.ts", "atomic.ts"]) write(name, `export const original = '${name}';\n`);
  const db = new VectorDB(store, 384);
  const meta = new MetaCache(path.join(temp, `${mode}-meta.lmdb`));
  pool = {
    isHealthy: () => true,
    processFile: async ({path: file}, signal) => {
      signal?.throwIfAborted();
      const bytes = fs.readFileSync(file), stat = fs.statSync(file);
      const hash = computeContentHash(bytes, file);
      return {hash, size: stat.size, mtimeMs: stat.mtimeMs, vectors: [{...db.seedRow(), id: `${file}:${hash}`, path: file, hash, content: bytes.toString(), start_line: 1, end_line: 1}]};
    },
  };
  let close, health;
  delivery = true;
  const beforeSubscribe = subscriptions;
  try {
    if (mode === "daemon") {
      const processors = new Map();
      const manager = new WatcherManager({processors, subscriptions: new Map(), getVectorDb: () => db,
        getMetaCache: () => meta, getWorkerPool: () => pool, getShuttingDown: () => false,
        touchActivity() {}, evictSearcher() {},
        runProjectOperation: (_root, _name, signal, fn) => fn(signal ?? new AbortController().signal),
      });
      await manager.watchProject(root);
      close = () => manager.unwatchProject(root);
      health = () => ({...processors.get(root).progress, ...manager.health(root)});
    } else {
      const handle = await startWatcher({projectRoot: root, dataDir: process.env.GMAX_HOME, vectorDb: db, metaCache: meta});
      close = () => handle.close();
      health = () => handle.health;
    }
    const verify = async names => {
      const state = health();
      assert.equal(state.catchupRunning, false);
      assert.equal(state.pendingFiles, 0);
      assert.equal(state.queue.activeFiles, 0);
      assert.equal(state.failedFiles, 0);
      const rows = await (await db.ensureTable()).query().select(["id", "path", "content", "hash"]).toArray();
      assert.deepEqual(rows.map(row => path.relative(root, row.path)).sort(), [...names].sort());
      assert.deepEqual([...(await meta.getKeysWithPrefix(root + path.sep))].map(p => path.relative(root, p)).sort(), [...names].sort());
      for (const name of names) {
        const file = absolute(name), bytes = fs.readFileSync(file), hash = computeContentHash(bytes, file);
        const row = rows.find(r => r.path === file);
        assert.equal(row.content, bytes.toString());
        assert.equal(row.hash, hash);
        assert.equal(meta.get(file).hash, hash);
        assert.equal(meta.get(file).hasVectors, true);
      }
    };
    await waitFor(async () => {
      assert(health().watcherRecovery.lastCompleteScan);
      await verify(["changed.ts", "removed.ts", "atomic.ts"]);
    }, `${mode} startup`);
    const attached = health().watcherRecovery.exclusions;
    assert.equal(attached.attached, true);
    assert(attached.literalCount > 0);
    // Native callback delivery, including an editor's rename-over save.
    write("changed.ts", "export const changed = 200;\n");
    write("created.ts", "export const created = 300;\n");
    fs.unlinkSync(absolute("removed.ts"));
    write(".!123!atomic.ts", "export const atomic = 400;\n");
    fs.renameSync(absolute(".!123!atomic.ts"), absolute("atomic.ts"));
    write("artifacts/generated.ts", "export const ignored = 1;\n");
    await waitFor(() => verify(["changed.ts", "created.ts", "atomic.ts"]), `${mode} native edits`);
    // Drop callback delivery deliberately; do not claim a real OS overflow.
    delivery = false;
    write("changed.ts", "export const changed = 50000;\n");
    write("lost.ts", "export const lost = 60000;\n");
    fs.unlinkSync(absolute("created.ts"));
    write(".!456!atomic.ts", "export const atomic = 70000;\n");
    fs.renameSync(absolute(".!456!atomic.ts"), absolute("atomic.ts"));
    await sleep(500);
    assert.equal(await db.countRowsForPath(absolute("lost.ts")), 0);
    assert.equal(await db.countRowsForPath(absolute("created.ts")), 1);
    callback(new Error("Events were dropped by the FSEvents client. File system must be re-scanned."), []);
    delivery = true;
    await waitFor(async () => {
      const recovery = health().watcherRecovery;
      assert.equal(recovery.gapCount, 1);
      assert.equal(recovery.coveredGapCount, 1);
      assert.equal(recovery.outstandingGapCount, 0);
      assert.equal(recovery.reconciliationNeeded, false);
      await verify(["changed.ts", "lost.ts", "atomic.ts"]);
    }, `${mode} injected-gap native-store convergence`, 45_000);
    assert.equal(subscriptions, beforeSubscribe + 1, "Gap recovery must retain the native subscription");
    assert.equal(health().watcherRecovery.exclusions.fingerprint, attached.fingerprint);
    // Actual policy control event replaces exclusions and indexes re-included content.
    write(".gmaxignore", "# re-include artifacts\n");
    await waitFor(async () => {
      assert.notEqual(health().watcherRecovery.exclusions.fingerprint, attached.fingerprint);
      await verify(["changed.ts", "lost.ts", "atomic.ts", "artifacts/generated.ts"]);
    }, `${mode} re-inclusion`);
    write(".gmaxignore", "/artifacts/\n");
    await waitFor(async () => {
      assert.equal(health().watcherRecovery.exclusions.fingerprint, attached.fingerprint);
      await verify(["changed.ts", "lost.ts", "atomic.ts"]);
    }, `${mode} policy retirement`);
    console.log(`Watcher consumer ${mode} (${process.platform}): native edits, atomic saves, injected gap convergence, retained subscription and policy re-inclusion/retirement passed`);
  } finally {
    delivery = true;
    await close?.();
    await meta.close();
    await db.close();
  }
}
(async () => {
  try { for (const mode of ["daemon", "standalone"]) await qualify(mode); }
  finally { fs.rmSync(temp, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
