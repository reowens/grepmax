// Run from audit-consumer's isolated installed project. Real packaged binaries,
// pinned Python and Node readers; every mutable store belongs to this fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const packageRoot = path.dirname(require.resolve("grepmax/package.json", { paths: [process.cwd()] }));
assert(packageRoot.startsWith(path.join(process.cwd(), "node_modules") + path.sep));
const load = file => require(path.join(packageRoot, "dist/lib/store", file));
const { prepareBoundedMaintenanceRuntime } = load("bounded-runtime.js");
const { runBoundedMaintenance } = load("bounded-maintenance.js");
const { prepareCleanupRuntime, runCleanupProcess } = load("lance-cleanup.js");
const { StoreLease } = load("store-lease.js");
const lance = load("lance-sdk.js");
const { prepareNodeBoundedFixture, verifyNodeBoundedFixture, nodeRowDigest } = require("./bounded-node-fixture.cjs");
const stores = [];
// Python opens the existing Node-created dataset read-only. Its independent
// complete-row digest includes the production binary and nullable fields.
const baseline = `
import hashlib, json, sys
import lance, pyarrow as pa
pa.set_cpu_count(1); pa.set_io_thread_count(1)
ds = lance.dataset(sys.argv[1])
actual = sorted(ds.to_table().to_pylist(), key=lambda row: row['id'])
digest = hashlib.sha256(json.dumps(actual, sort_keys=True, default=lambda value: {'binary': value.hex()}).encode()).hexdigest()
print(json.dumps({'version': ds.version, 'digest': digest, 'rows': len(actual), 'deletedRows': sum(f.num_deletions for f in ds.get_fragments()), 'schemaFields': len(ds.schema), 'userVersion': ds.tags.get_version('user-reader')}))
`;
const verify = `
import hashlib, json, sys
import lance
ds = lance.dataset(sys.argv[1])
rows = sorted(ds.to_table().to_pylist(), key=lambda row: row['id'])
digest = hashlib.sha256(json.dumps(rows, sort_keys=True, default=lambda value: {'binary': value.hex()}).encode()).hexdigest()
assert digest == sys.argv[2], 'Complete row digest changed'
assert ds.tags.get_version('user-reader') == int(sys.argv[3]), 'Existing user reader tag changed'
receipt = json.loads((__import__('pathlib').Path(sys.argv[1]) / '_gmax-bounded-receipt.json').read_text())
print(json.dumps({'version': ds.version, 'rows': len(rows), 'deletedRows': sum(f.num_deletions for f in ds.get_fragments()), 'receiptPhase': receipt['phase']}))
`;

(async () => {
  const native = await prepareBoundedMaintenanceRuntime();
  assert(native, "Accepted bundled native maintenance artifact is required; this is not a skip qualification");
  const python = await prepareCleanupRuntime();
  const evidence = [];
  for (const interrupted of [false, true]) {
    const store = fs.mkdtempSync(path.join(process.cwd(), "bounded-consumer-"));
    stores.push(store);
    const table = path.join(store, "chunks.lance");
    const prepared = await prepareNodeBoundedFixture(lance, store, packageRoot);
    const pythonBaseline = JSON.parse(await runCleanupProcess(python.python, ["-I", "-c", baseline, table]));
    assert.equal(pythonBaseline.version, prepared.version);
    assert.equal(pythonBaseline.rows, prepared.rows);
    assert.equal(pythonBaseline.schemaFields, 29);
    assert.equal(pythonBaseline.userVersion, prepared.userVersion);
    assert(pythonBaseline.deletedRows > 0);
    const lease = await StoreLease.acquireExclusive({ storeDir: store, timeoutMs: 5000, role: "packaged-bounded-consumer" });
    let connection;
    let reader;
    let stopReads = false;
    let pendingReads;
    let reads = 0;
    const controller = new AbortController();
    const readOnce = async () => {
      const rows = await reader.query().select(["id", "path", "content"]).toArray();
      assert.equal(rows.length, prepared.rows);
      assert.deepEqual(rows.map(row => row.id).sort(), prepared.expectedIds);
      reads++;
    };
    const callbacks = {
      async open(protection) {
        assert.equal(protection.protectedVersion, prepared.version);
        if (interrupted) { controller.abort(new Error("fixture interruption before copy")); return; }
        connection = await lance.connect(store, { session: new lance.Session(BigInt(16 * 1024 ** 2), BigInt(8 * 1024 ** 2)) });
        reader = await connection.openTable("chunks");
        await reader.checkout(protection.protectedVersion);
        assert.equal((await nodeRowDigest(reader)).digest, prepared.nodeDigest);
        await readOnce();
        pendingReads = (async () => {
          while (!stopReads) { await readOnce(); await new Promise(resolve => setTimeout(resolve, 2)); }
        })();
      },
      async drain() {
        stopReads = true;
        await pendingReads;
        reader?.close(); reader = undefined;
        await connection?.close(); connection = undefined;
      },
    };
    try {
      connection = await lance.connect(store, { session: new lance.Session(BigInt(16 * 1024 ** 2), BigInt(8 * 1024 ** 2)) });
      reader = await connection.openTable("chunks");
      const before = await verifyNodeBoundedFixture(reader, prepared);
      reader.close(); reader = undefined;
      await connection.close(); connection = undefined;
      const noRecovery = await runBoundedMaintenance(store, lease, prepared.version, native, { open() { assert.fail("Empty recovery must not open a tag window"); }, async drain() {} }, undefined, "recover");
      assert.equal(noRecovery.status, "skipped");
      assert.equal(noRecovery.recoveryPending, false);
      assert.equal(noRecovery.totalBytesWritten, 0);
      if (interrupted) {
        await assert.rejects(runBoundedMaintenance(store, lease, prepared.version, native, callbacks, controller.signal, "run"), /uncertain/);
        const recovered = await runBoundedMaintenance(store, lease, prepared.version, native, { open(p) { assert.equal(p.protectedVersion, prepared.version); }, async drain() {} }, undefined, "recover");
        assert.equal(recovered.aborted, true);
        assert.equal(recovered.rewritten, false);
        assert.equal(recovered.rowsVerified, 0);
        assert.equal(recovered.afterVersion, prepared.version);
        assert.equal(recovered.dataBytesWritten, 0);
        assert.equal(recovered.indexBytesWritten, 0);
        assert.equal(recovered.remainingDeletedRows, pythonBaseline.deletedRows);
        assert.match(recovered.reason, /unfinished copy discarded/);
        evidence.push({ kind: "interrupted-before-copy", before, seed: prepared, result: recovered });
      } else {
        const result = await runBoundedMaintenance(store, lease, prepared.version, native, callbacks, undefined, "run");
        assert.equal(result.status, "completed");
        assert.equal(result.aborted, false);
        assert(result.afterVersion > prepared.version);
        assert(result.totalBytesWritten <= 512 * 1024 ** 2);
        assert(result.indexBytesWritten > 0);
        assert.equal(result.remainingDeletedRows, 0);
        assert(reads > 1, "Actual native copying must overlap Node reads of the tagged head");
        evidence.push({ kind: "actual-copy-with-node-readers", reads, before, seed: prepared, result });
      }
      const verified = JSON.parse(await runCleanupProcess(python.python, ["-I", "-c", verify, table, pythonBaseline.digest, String(prepared.userVersion)]));
      assert.equal(verified.receiptPhase, "finalized");
      assert.equal(verified.deletedRows, interrupted ? pythonBaseline.deletedRows : 0);
      connection = await lance.connect(store, { session: new lance.Session(BigInt(16 * 1024 ** 2), BigInt(8 * 1024 ** 2)) });
      reader = await connection.openTable("chunks");
      const outcome = evidence[evidence.length - 1].result;
      assert.equal(await reader.version(), outcome.afterVersion, "Reopened Node reader must read the native current manifest");
      assert.equal(verified.version, outcome.afterVersion);
      if (!interrupted) assert((await reader.version()) > prepared.version);
      const after = await verifyNodeBoundedFixture(reader, prepared);
      evidence[evidence.length - 1].after = after;
      evidence[evidence.length - 1].verified = verified;
    } finally {
      stopReads = true;
      await pendingReads;
      reader?.close();
      await connection?.close();
      await lease.release();
    }
  }
  console.log(JSON.stringify({ boundedConsumer: "passed", evidence }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const store of stores) {
    fs.rmSync(store, { recursive: true, force: true });
    fs.rmSync(`${store}.lease`, { recursive: true, force: true });
  }
});
