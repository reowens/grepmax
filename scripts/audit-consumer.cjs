// Audit and exercise the actual tarball without repository overrides or peers.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-packed-consumer-"));
// npm 12 exports the parent lifecycle script policy as CLI-like env config.
// It is invalid for this separate consumer project; all our installs explicitly
// ignore scripts, so do not inherit that parent allowance.
const npmEnv = { ...process.env };
for (const key of Object.keys(npmEnv)) {
  if (/^npm_config_(allow_scripts|strict_allow_scripts|dangerously_allow_all_scripts)$/i.test(key)) delete npmEnv[key];
}
function npm(args, cwd = temp, acceptFailure = false) {
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd, env: npmEnv, encoding: "utf8", timeout: 180_000,
  });
  if (r.error || (r.status !== 0 && !acceptFailure)) {
    throw new Error(`npm ${args.join(" ")} failed: ${r.error ?? r.stderr ?? r.stdout}`);
  }
  return r;
}
try {
  const packOutput = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp], root).stdout);
  const packed = (Array.isArray(packOutput) ? packOutput : Object.values(packOutput))[0];
  if (!packed?.filename) throw new Error("npm pack returned no tarball metadata");
  fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ name: "gmax-consumer-check", version: "1.0.0", private: true }));
  npm(["install", path.join(temp, packed.filename), "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online"]);
  const auditResult = npm(["audit", "--omit=dev", "--json"], temp, true);
  const audit = JSON.parse(auditResult.stdout);
  if (audit.error || auditResult.status !== 0) {
    console.error(JSON.stringify(audit, null, 2));
    throw new Error("Packed consumer audit failed");
  }
  const lock = JSON.parse(fs.readFileSync(path.join(temp, "package-lock.json"), "utf8"));
  if (Object.keys(lock.packages).some((p) => p.endsWith("node_modules/@lancedb/lancedb"))) {
    throw new Error("Consumer resolved the SDK provider dependency manifest");
  }
  console.log("Packed consumer audit: no vulnerabilities");
  npm(["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"]);
  const smoke = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs'), path = require('node:path');
    const { VectorDB } = require('grepmax/dist/lib/store/vector-db.js');
    (async () => {
      const store = path.join(process.cwd(), 'fixture');
      const db = new VectorDB(store, 384);
      try {
        await db.insertBatch([{ ...db.seedRow(), id: 'fixture', path: '/fixture/a.ts', content: 'consumer fixture' }]);
        await db.createVectorIndex();
        if (!(await db.hasRowsForPath('/fixture/')) || db.cacheSizeBytes() <= 152) throw new Error('Native runtime/session smoke failed');
        console.log('Packed consumer native runtime and Session: pass');
      } finally { await db.close(); fs.rmSync(store, { recursive: true, force: true }); }
    })().catch((e) => { console.error(e); process.exitCode = 1; });
  `], { cwd: temp, encoding: "utf8", timeout: 30_000 });
  if (smoke.error || smoke.status !== 0) throw new Error(`Consumer native smoke failed: ${smoke.error ?? smoke.stderr}`);
  process.stdout.write(smoke.stdout);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
