// Run only from audit-consumer's isolated installed project. No source imports.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const packageRoot = path.dirname(require.resolve("grepmax/package.json", {paths: [process.cwd()]}));
assert(packageRoot.startsWith(path.join(process.cwd(), "node_modules") + path.sep));
const {prepareCleanupRuntime, pruneVersions, runCleanupProcess} = require(path.join(packageRoot, "dist/lib/store/lance-cleanup.js"));
const {spawnSync} = require("node:child_process");
const {StoreLease} = require(path.join(packageRoot, "dist/lib/store/store-lease.js"));
const {readPruneState} = require(path.join(packageRoot, "dist/lib/store/prune-state.js"));
const fixtureAdmission = () => ({start() {}, approve() {}, check() {}, close() {}});
const lance = require(path.join(packageRoot, "dist/lib/store/lance-sdk.js"));
const sourceRoot = path.resolve(__dirname, "..");

const prepare = `
import json, sys, time
from pathlib import Path
import lance, pyarrow as pa
root = Path(sys.argv[1])
assert not root.exists()
table = pa.table({"id": ["protected"], "content": ["protected fixture"]})
ds = lance.write_dataset(table, str(root))
ds.tags.create("protected", ds.version)
ds = lance.write_dataset(pa.table({"id": [str(i) for i in range(100)], "content": ["obsolete fixture"] * 100}), str(root), mode="overwrite")
ds = lance.write_dataset(pa.table({"id": ["current"], "content": ["retainedneedle"]}), str(root), mode="overwrite")
time.sleep(0.02)
cutoff = time.time_ns() // 1_000_000
time.sleep(0.02)
ds = lance.write_dataset(pa.table({"id": ["tail"], "content": ["tail fixture"]}), str(root), mode="append")
print(json.dumps({"version": ds.version, "cutoffMs": cutoff, "tagged": ds.tags.get_version("protected")}))
`;
const verify = `
import json, sys
import lance
ds = lance.dataset(sys.argv[1])
assert ds.count_rows() == 2
assert set(ds.to_table()["id"].to_pylist()) == {"current", "tail"}
tagged = ds.tags.get_version("protected")
assert lance.dataset(sys.argv[1], version=tagged).to_table()["id"].to_pylist() == ["protected"]
print(json.dumps({"version": ds.version, "tagged": tagged, "rows": ds.count_rows()}))
`;
(async () => {
  const store = path.join(process.cwd(), "prune-consumer-store");
  fs.mkdirSync(store);
  let lease;
  let connection;
  try {
    const runtime = await prepareCleanupRuntime();
    assert.equal(runtime.script, path.join(packageRoot, "lance-maintenance/prune.py"));
    for (const file of ["prune.py", "pyproject.toml", "uv.lock"]) {
      const digest = root => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "lance-maintenance", file))).digest("hex");
      assert.equal(digest(packageRoot), digest(sourceRoot), `Packed ${file} changed`);
    }
    const cacheCheck = await runCleanupProcess(process.execPath, ["-e", `require(${JSON.stringify(path.join(packageRoot,"dist/lib/store/lance-cleanup.js"))}).prepareCleanupRuntime().catch(e=>{console.error(e);process.exitCode=1})`]);
    assert.equal(cacheCheck, "");
    const table = path.join(store, "chunks.lance");
    const prepared = JSON.parse(await runCleanupProcess(runtime.python, ["-I", "-c", prepare, table]));
    const cliStatus = () => {
      const run = spawnSync(process.execPath,[path.join(packageRoot,"dist/bin.js"),"recover","--table",table,"--json"],{encoding:"utf8",timeout:10000});
      assert.equal(run.status,0,run.stderr);
      return JSON.parse(run.stdout);
    };
    assert.equal(cliStatus().state,null);
    lease = await StoreLease.acquireExclusive({storeDir: store, timeoutMs: 5000, role: "packed-consumer-fixture"});
    const result = await pruneVersions(runtime, table, prepared.version, new Date(prepared.cutoffMs), {lease, admission: fixtureAdmission()});
    assert.equal(result.rewritten, false);
    assert(result.versionsRemoved > 0);
    assert(result.bytesRemoved > 0);
    const verified = JSON.parse(await runCleanupProcess(runtime.python, ["-I", "-c", verify, table]));
    assert.equal(verified.version, prepared.version);
    assert.equal(verified.tagged, prepared.tagged);
    const state = readPruneState(store);
    assert.equal(state.outcome, "completed");
    assert.deepEqual(state.result, result);
    assert.equal(cliStatus().state.outcome,"completed");
    await lease.release();
    lease = undefined;
    connection = await lance.connect(store, {session: new lance.Session(BigInt(16 * 1024**2), BigInt(8 * 1024**2))});
    assert.equal(await (await connection.openTable("chunks")).countRows(), 2);
    console.log("Packed prune runtime: locked setup, exact helper files, exclusive deletion, protected/current rows, durable receipt and Node reopen passed");
  } finally {
    await connection?.close();
    await lease?.release();
    fs.rmSync(store, {recursive: true, force: true});
    fs.rmSync(`${store}.lease`, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
