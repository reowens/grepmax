const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { nativeSourceDigest } = require("./bounded-source-digest.cjs");

// Qualified binaries are built and accepted on dedicated platform runners.
// Normal source builds can omit them; the daemon then continues version-only
// cleanup. No compiler, download or experimental executable is used at runtime.
const root = path.resolve(__dirname, "..");
const positional = process.argv.slice(2).filter(arg => arg !== "--required");
if (positional.length > 2 || positional.some(arg => arg.startsWith("--"))) throw new Error("Invalid runtime preparation arguments");
const source = positional[0] ? path.resolve(positional[0]) : path.join(root, "lance-maintenance/artifacts");
const destination = positional[1] ? path.resolve(positional[1]) : path.join(root, "dist/vendor/maintenance");
const required = process.argv.includes("--required");
if (!fs.existsSync(path.join(source, "manifest.json"))) {
  if (required) throw new Error("Qualified native cleanup artifacts missing");
  process.exit(0);
}
const stat = fs.lstatSync(path.join(source, "manifest.json"));
if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Unsafe native artifact manifest");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1 || manifest.engine !== "12.0.0" || manifest.qualified !== true ||
    manifest.sourceSha256 !== nativeSourceDigest(path.join(root, "lance-maintenance/native"))) {
  throw new Error("Native artifacts are unqualified or built from different source");
}
const platforms = ["darwin-arm64", "linux-x64"];
if (JSON.stringify(Object.keys(manifest.binaries ?? {}).sort()) !== JSON.stringify(platforms)) {
  throw new Error("Native artifact platform set does not match the qualified targets");
}
// Verify every input before creating any output. Binary payloads are bounded;
// build-time hashing runs off the development host for release packages.
const verified = [];
for (const platform of platforms) {
  const name = `gmax-bounded-maintenance-${platform}`;
  const entry = manifest.binaries[platform];
  if (entry.file !== name || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid native artifact entry");
  const file = path.join(source, name);
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > 256 * 1024 ** 2) throw new Error("Unsafe native artifact binary");
  if (crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== entry.sha256) {
    throw new Error("Native artifact checksum mismatch");
  }
  verified.push([file, name]);
}
const proofPath = path.join(source, "acceptance.json");
const proofStat = fs.lstatSync(proofPath);
if (!proofStat.isFile() || proofStat.size > 64 * 1024) throw new Error("Unsafe native acceptance proof");
const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
if (proof.schemaVersion !== 1 || proof.sourceSha256 !== manifest.sourceSha256) throw new Error("Native acceptance source mismatch");
for (const platform of platforms) {
  const result = proof.platforms?.[platform];
  if (result?.verdict !== "PASS_BOUNDED_NATIVE_ACCEPTANCE" || !Number.isSafeInteger(result.tests?.executed) ||
      result.tests.executed < 21 || result.tests.passed !== result.tests.executed || result.tests.skipped !== 0 ||
      result.binarySha256 !== manifest.binaries[platform].sha256 || result.sourceDigest !== manifest.sourceSha256 ||
      result.provenanceUnchanged !== true || result.faultRecovery?.verdict !== "PASS_BOUNDED_NATIVE_FAULT_ACCEPTANCE" ||
      result.faultRecovery?.sourceDigest !== manifest.sourceSha256 || result.faultRecovery?.provenanceUnchanged !== true ||
      result.faultRecovery?.tests?.executed < 4 || result.faultRecovery?.tests?.passed !== result.faultRecovery?.tests?.executed ||
      result.faultRecovery?.tests?.skipped !== 0) throw new Error("Native execution acceptance incomplete");
}
for (const name of ["THIRD-PARTY-NOTICES.txt", "acceptance.json"]) {
  const file = path.join(source, name);
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.size > 16 * 1024 ** 2) throw new Error(`Unsafe native ${name}`);
  verified.push([file, name]);
}
fs.mkdirSync(destination, {recursive: true});
for (const [file, name] of verified) {
  fs.copyFileSync(file, path.join(destination, name));
  fs.chmodSync(path.join(destination, name), name.startsWith("gmax-bounded-maintenance-") ? 0o755 : 0o644);
}
fs.copyFileSync(path.join(source, "manifest.json"), path.join(destination, "manifest.json"));
