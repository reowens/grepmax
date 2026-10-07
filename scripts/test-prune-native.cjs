const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
// Only this synthetic CI harness exposes bounded native stderr. Production
// cleanup still keeps subprocess diagnostics private and sanitized.
const childProcess = require("node:child_process");
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  let logged = 0;
  child.stderr?.on("data", (chunk) => {
    if (logged >= 8192) return;
    const piece = chunk.subarray(0, 8192 - logged);
    logged += piece.length;
    process.stderr.write(piece);
  });
  return child;
};
const { StoreLease } = require("../src/lib/store/store-lease.ts");
const { pruneVersions, runCleanupProcess } = require("../src/lib/store/lance-cleanup.ts");
const lance = require("../src/lib/store/lance-sdk.ts");

(async () => {
  const python = process.env.PRUNE_PYTHON;
  assert(python, "Locked fixture Python is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-prune-native-"));
  const store = path.join(root, "store");
  fs.mkdirSync(store);
  const tablePath = path.join(store, "chunks.lance");
  let lease;
  let connection;
  try {
    const fixture = path.join(__dirname, "prune-native-fixture.py");
    const prepared = JSON.parse(await runCleanupProcess(python, ["-I", fixture, "prepare", tablePath]));
    console.log(JSON.stringify({phase:"prepared",...prepared}));
    assert(prepared.fragments >= 50);
    lease = await StoreLease.acquireExclusive({ storeDir: store, timeoutMs: 5000, role: "isolated-prune-test" });
    const started = Date.now();
    const result = await pruneVersions({python,script:path.resolve("lance-maintenance/prune.py")}, tablePath, prepared.version, new Date(prepared.cutoffMs), {lease});
    console.log(JSON.stringify({phase:"pruned",...result}));
    assert(result.versionsRemoved > 0);
    assert(result.fileBytesBefore - result.fileBytesAfter > 500 * 1024**2);
    assert(result.allocatedBytesBefore > result.allocatedBytesAfter);
    const verified = JSON.parse(await runCleanupProcess(python,["-I",fixture,"verify",tablePath]));
    // Read the exact Python/Lance-12 store through the pinned Node writer engine.
    connection = await lance.connect(store,{session:new lance.Session(BigInt(32*1024**2),BigInt(16*1024**2))});
    const table = await connection.openTable("chunks");
    assert.equal(await table.version(), prepared.version);
    assert.equal(await table.countRows(), prepared.rows);
    const hits = await table.search("retainedneedle").fastSearch().select(["id","content"]).limit(3).toArray();
    assert(hits.length > 0);
    const tail = await table.search("unindexedtailneedle").fastSearch().select(["id"]).limit(1).toArray();
    assert.equal(tail.length,0,"Partial FTS must remain partial");
    console.log(JSON.stringify({prepared,result,verified,nodeKeywordHits:hits.length,elapsedMs:Date.now()-started,platform:process.platform}));
  } finally {
    await connection?.close();
    await lease?.release();
    fs.rmSync(root,{recursive:true,force:true});
  }
})().catch((error)=>{console.error(error);process.exitCode=1;});
