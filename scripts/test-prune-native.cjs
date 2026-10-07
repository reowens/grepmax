const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const originalSpawn = childProcess.spawn;
const observations = [];
let interruption;

function sampleProcess(pid) {
  try {
    if (process.platform === "linux") {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      return { rssBytes: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024,
        threads: Number(/Threads:\s+(\d+)/.exec(status)?.[1] ?? 0) };
    }
    const rss = childProcess.execFileSync("ps", ["-p", String(pid), "-o", "rss="], {encoding:"utf8", timeout:1000}).trim();
    const threads = childProcess.execFileSync("ps", ["-M", "-p", String(pid)], {encoding:"utf8", timeout:1000}).trim().split("\n").length - 1;
    return {rssBytes: Number(rss) * 1024, threads};
  } catch { return null; }
}

// Only the synthetic CI harness records bounded native diagnostics/resources.
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  const observation = { executable: path.basename(args[0]), phase: path.basename(args[1]?.[1] ?? ""), samples:0,
    peakHelperRssSampledBytes:0, peakHarnessRssSampledBytes:0, peakRssSumSampledBytes:0, peakThreadsSampled:0 };
  observations.push(observation);
  const timer = setInterval(() => {
    const helper = sampleProcess(child.pid);
    const harness = sampleProcess(process.pid);
    if (!helper || !harness) return;
    observation.samples++;
    observation.peakHelperRssSampledBytes = Math.max(observation.peakHelperRssSampledBytes, helper.rssBytes);
    observation.peakHarnessRssSampledBytes = Math.max(observation.peakHarnessRssSampledBytes, harness.rssBytes);
    observation.peakRssSumSampledBytes = Math.max(observation.peakRssSumSampledBytes, helper.rssBytes + harness.rssBytes);
    observation.peakThreadsSampled = Math.max(observation.peakThreadsSampled, helper.threads);
  }, 200);
  let logged = 0;
  child.stderr?.on("data", chunk => {
    if (logged >= 8192) return;
    const piece = chunk.subarray(0, 8192 - logged);
    logged += piece.length;
    process.stderr.write(piece);
  });
  let deletionTimer;
  if (interruption && args[1]?.includes("--store")) {
    const action = interruption;
    interruption = undefined;
    action.child = child;
    deletionTimer = setInterval(() => {
      const removed = action.paths.filter(file => !fs.existsSync(file));
      if (removed.length === 0) return;
      clearInterval(deletionTimer);
      action.removedAtSignal = removed.length;
      action.triggered = true;
      if (action.mode === "abort") action.controller.abort();
      else child.kill("SIGKILL");
    }, 50);
  }
  child.once("close", (code, signal) => {
    clearInterval(timer);
    clearInterval(deletionTimer);
    observation.exitCode = code;
    observation.signal = signal;
  });
  return child;
};
const { StoreLease, storeLeasePaths } = require("../src/lib/store/store-lease.ts");
const { pruneVersions, runCleanupProcess } = require("../src/lib/store/lance-cleanup.ts");
const { readPruneState } = require("../src/lib/store/prune-state.ts");
const lance = require("../src/lib/store/lance-sdk.ts");
const python = process.env.PRUNE_PYTHON;
const evidenceDir = process.env.GMAX_PRUNE_EVIDENCE;
const reports = [];
const report = value => { reports.push(value); console.log(JSON.stringify(value)); };

async function spawnLeaseOwner(store, mode) {
  const child = childProcess.spawn(process.execPath, ["--max-old-space-size=64", "--import", "tsx",
    path.join(__dirname, "prune-lease-fixture.cjs"), store, mode], {
    env: {PATH:process.env.PATH}, stdio:["ignore","pipe","pipe","ipc"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Lease fixture did not start")); }, 10000);
    child.once("message", () => {clearTimeout(timer); resolve();});
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("exit", code => {clearTimeout(timer); reject(new Error(`Lease fixture exited ${code}`));});
  });
  return child;
}
async function stopOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once("close", resolve); child.kill("SIGKILL"); });
}
async function leaseCases(store) {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const mode of ["shared", "exclusive"]) {
      const child = await spawnLeaseOwner(store, mode);
      try {
        await assert.rejects(StoreLease.acquireExclusive({storeDir:store, timeoutMs:200, pollMs:20}), /Timed out/);
        await stopOwned(child);
        const recovered = await StoreLease.acquireExclusive({storeDir:store, timeoutMs:5000});
        await recovered.release();
        report({phase:"lease-recovery", mode, refusedLiveOwner:true, recoveredKilledOwner:true});
      } finally { await stopOwned(child); }
    }
    const paths = storeLeasePaths(store);
    const unknown = path.join(paths.readersDir, "task-owned-unknown.json");
    fs.writeFileSync(unknown, "unverified fixture owner", {flag:"wx"});
    try {
      await assert.rejects(StoreLease.acquireExclusive({storeDir:store, timeoutMs:200, pollMs:20}), /Timed out/);
      assert(fs.existsSync(unknown), "Unknown owner must not be removed");
      report({phase:"unknown-owner", refused:true, retainedMarker:true});
    } finally { fs.unlinkSync(unknown); }
  } finally { clearInterval(keepAlive); }
}
async function verifyNative(store, prepared) {
  const connection = await lance.connect(store,{session:new lance.Session(BigInt(32*1024**2),BigInt(16*1024**2))});
  try {
    const table = await connection.openTable("chunks");
    assert.equal(await table.version(), prepared.version);
    assert.equal(await table.countRows(), prepared.rows);
    const hits = await table.search("retainedneedle").fastSearch().select(["id","content"]).limit(3).toArray();
    assert(hits.length > 0);
    const tail = await table.search("unindexedtailneedle").fastSearch().select(["id"]).limit(1).toArray();
    assert.equal(tail.length,0,"Partial FTS must remain partial");
    return {nodeKeywordHits:hits.length, partialFtsPreserved:true};
  } finally { await connection.close(); }
}
async function runCase(mode) {
  const root = fs.mkdtempSync(path.join(process.env.GMAX_PRUNE_FIXTURE_BASE, "gmax-prune-native-"));
  const store = path.join(root,"store");
  fs.mkdirSync(store);
  const tablePath = path.join(store,"chunks.lance");
  const fixture = path.join(__dirname,"prune-native-fixture.py");
  const runtime = {python, script:path.join(__dirname,"prune-resource-wrapper.py")};
  let lease;
  try {
    const prepared = JSON.parse(await runCleanupProcess(python,["-I",fixture,"prepare",tablePath]));
    report({phase:"prepared",mode,...prepared});
    assert(prepared.fragments >= 50);
    assert(prepared.resources.peakRssBytes < 1536*1024**2, "Fixture RSS exceeded 1.5GiB CI budget");
    if (mode === "complete") await leaseCases(store);
    lease = await StoreLease.acquireExclusive({storeDir:store,timeoutMs:5000,role:"isolated-prune-test"});
    const started = Date.now();
    if (mode !== "complete") {
      const manifest = JSON.parse(fs.readFileSync(path.join(store,"fixture.json"),"utf8"));
      const action = {mode, controller:new AbortController(), paths:Object.keys(manifest.hashes)
        .filter(file => /(?:^|\/)(?:_?data)\//.test(file) && file.endsWith(".lance"))
        .map(file => path.join(tablePath,file)), triggered:false};
      assert(action.paths.length >= 50);
      interruption = action;
      await assert.rejects(pruneVersions(runtime,tablePath,prepared.version,new Date(prepared.cutoffMs),
        {lease,signal:action.controller.signal}), /completion is uncertain/);
      assert(action.triggered, "Interruption must follow a real native deletion");
      assert(action.child.exitCode !== null || action.child.signalCode !== null, "Child must exit before lease release");
      assert.equal(readPruneState(store).outcome, "uncertain");
      const partial = JSON.parse(await runCleanupProcess(python,["-I",fixture,"verify",tablePath]));
      const partialNative = await verifyNative(store,prepared);
      report({phase:"interrupted",mode,removedAtSignal:action.removedAtSignal,partial,...partialNative,completionUncertain:true});
      await lease.release();
      lease = await StoreLease.acquireExclusive({storeDir:store,timeoutMs:5000,role:"isolated-prune-retry"});
    } else {
      // A real timeout before deletion validates bounded shutdown and exclusion.
      await assert.rejects(lease.withExclusiveUse(store, () => runCleanupProcess(python,
        ["-I","-c","import time; time.sleep(60)"],{timeoutMs:100})), /timed out.*uncertain/);
      report({phase:"timeout-before-deletion",completionUncertain:true,childClosedBeforeRelease:true});
      await assert.rejects(pruneVersions(runtime,tablePath,prepared.version+1,new Date(prepared.cutoffMs),{lease}), /uncertain/);
    }
    const result = await pruneVersions(runtime,tablePath,prepared.version,new Date(prepared.cutoffMs),{lease});
    const receipt = readPruneState(store);
    assert.equal(receipt.outcome, "completed");
    assert.deepEqual(receipt.result, result);
    if (mode !== "complete") assert(receipt.previousUncertainAttemptId);
    const resources = JSON.parse(fs.readFileSync(path.join(store,"helper-resources.json"),"utf8"));
    assert(resources.peakRssBytes < 1024**3, "Prune helper RSS exceeded 1GiB CI budget");
    const verified = JSON.parse(await runCleanupProcess(python,["-I",fixture,"verify",tablePath]));
    const native = await verifyNative(store,prepared);
    const recovery = {
      fileBytes:prepared.measurements.fileBytes-verified.measurements.fileBytes,
      allocatedBytes:prepared.measurements.allocatedBytes-verified.measurements.allocatedBytes,
      freeBytes:verified.measurements.freeBytes-prepared.measurements.freeBytes,
    };
    assert(recovery.fileBytes > 500*1024**2);
    assert(recovery.allocatedBytes > 500*1024**2);
    if (process.platform === "darwin") assert(recovery.freeBytes > 400*1024**2, "APFS free-space recovery not established");
    report({phase:"verified",mode,prepared,result,resources,verified,recovery,...native,elapsedMs:Date.now()-started});
  } finally {
    interruption = undefined;
    await lease?.release();
    fs.rmSync(root,{recursive:true,force:true});
  }
}
(async () => {
  assert(process.env.GITHUB_ACTIONS === "true" && process.env.CI === "true", "Production-size fixtures are remote CI only");
  assert(python && path.isAbsolute(python), "Locked fixture Python is required");
  assert(evidenceDir && process.env.GMAX_PRUNE_FIXTURE_BASE, "Task-owned evidence/fixture directories are required");
  const identities = Object.fromEntries(["package.json","pnpm-lock.yaml","lance-maintenance/prune.py","lance-maintenance/pyproject.toml",
    "lance-maintenance/uv.lock","src/lib/store/lance-cleanup.ts","src/lib/store/store-lease.ts",
    "src/lib/store/lance-sdk.ts","src/lib/store/prune-state.ts","scripts/test-prune-native.cjs","scripts/prune-native-fixture.py",
    "scripts/prune-resource-wrapper.py"].map(file => [file,crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
  report({phase:"identity",source:process.env.GITHUB_SHA,platform:process.platform,arch:process.arch,
    osRelease:os.release(),node:process.version,identities,
    resourceLimits:{helperRssBytes:1024**3,fixtureRssBytes:1536*1024**2,sampledRssSumBytes:2*1024**3,helperThreadsSampled:64},
    resourceLimitScope:"CI acceptance budgets; sampled RSS is not an enforced macOS footprint cap"});
  for (const mode of ["complete","abort","kill"]) await runCase(mode);
  assert(observations.every(item => item.peakRssSumSampledBytes < 2*1024**3));
  assert(observations.every(item => item.peakThreadsSampled <= 64));
  report({phase:"resources",observations,samplingIntervalMs:200,measurement:"RSS sum may double-count shared pages; not physical footprint; interrupted peaks are sampled"});
})().catch(error => {report({phase:"failure",error:error.stack});process.exitCode=1;}).finally(() => {
  if (evidenceDir) {
    fs.mkdirSync(evidenceDir,{recursive:true});
    fs.writeFileSync(path.join(evidenceDir,"summary.json"),JSON.stringify({reports,observations,ok:!process.exitCode},null,2));
  }
});
