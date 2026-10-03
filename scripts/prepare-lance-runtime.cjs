// Ship the pinned official JavaScript runtime without its unused optional
// provider manifests. Native binaries remain normal platform dependencies.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const manifest = require(path.join(root, "package.json"));
const sdkDir = path.dirname(path.dirname(require.resolve("@lancedb/lancedb")));
const sdk = JSON.parse(fs.readFileSync(path.join(sdkDir, "package.json"), "utf8"));
if (sdk.version !== manifest.devDependencies["@lancedb/lancedb"]) {
  throw new Error("Lance runtime version does not match the exact development pin");
}
for (const [name, version] of Object.entries(sdk.optionalDependencies)) {
  if (name.startsWith("@lancedb/lancedb-") && manifest.optionalDependencies[name] !== version) {
    throw new Error(`Native runtime pin mismatch: ${name}`);
  }
}
for (const name of Object.keys(sdk.dependencies)) {
  if (!manifest.dependencies[name]) throw new Error(`Missing Lance runtime dependency: ${name}`);
}
const target = path.join(root, "dist", "vendor", "lancedb");
fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.join(sdkDir, "dist"), target, { recursive: true });
fs.copyFileSync(path.join(root, "licenses", "lancedb-LICENSE"), path.join(target, "LICENSE"));
for (const name of ["license_header.txt", "NODEJS_THIRD_PARTY_LICENSES.md", "RUST_THIRD_PARTY_LICENSES.html"]) {
  fs.copyFileSync(path.join(sdkDir, name), path.join(target, name));
}
// No dependency manifest is copied: npm must not resolve SDK provider pins.
fs.writeFileSync(path.join(target, "provenance.json"), JSON.stringify({
  package: sdk.name,
  version: sdk.version,
  upstream: sdk.repository.url,
  entrySha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(target, "index.js"))).digest("hex"),
}, null, 2) + "\n");
