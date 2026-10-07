// Exact released .64 StoreLease source is fetched by isolated CI.
const assert = require("node:assert/strict");
const {StoreLease} = require("./.prune-legacy-store-lease.ts");
const keepAlive = setInterval(() => {},1000);
(async () => {
  await assert.rejects(StoreLease.acquireShared({storeDir: process.argv[2], timeoutMs: 200, pollMs: 20}), /Timed out/);
  console.log("Released .64 reader retained exclusion for orphaned active helper");
})().catch(error => {console.error(error);process.exitCode=1;}).finally(() => clearInterval(keepAlive));
