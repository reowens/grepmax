// Remote fixture only: parent is deliberately killed after a real deletion.
const {pruneVersions} = require("../src/lib/store/lance-cleanup.ts");
const {StoreLease} = require("../src/lib/store/store-lease.ts");
const path = require("node:path");
(async () => {
  if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Remote fixture only");
  const [table, version, cutoff, python] = process.argv.slice(2);
  const lease = await StoreLease.acquireExclusive({storeDir: path.dirname(table), timeoutMs: 5000, role: "task-owned-parent-interruption"});
  try {
    await pruneVersions({python, script: path.join(__dirname, "prune-resource-wrapper.py")}, table, Number(version), new Date(Number(cutoff)), {lease,
      admission: {start: pid => process.send({helperPid: pid}), approve() {}, check() {}, close() {}}});
  } finally {await lease.release();}
})().catch(error => {console.error(error); process.exitCode = 1;});
