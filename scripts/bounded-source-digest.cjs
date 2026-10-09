const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Frame each relative name and payload length. Artifacts are reusable only
// against this exact native source and locked dependency resolution.
function nativeSourceDigest(root) {
  const files = ["Cargo.toml", "Cargo.lock"];
  function walk(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), {withFileTypes: true})) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Native source symlink refused");
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(relative);
    }
  }
  walk("src");
  const digest = crypto.createHash("sha256");
  for (const relative of files.sort()) {
    const data = fs.readFileSync(path.join(root, relative));
    digest.update(`${Buffer.byteLength(relative)}:${relative}:${data.length}:`);
    digest.update(data);
  }
  return digest.digest("hex");
}
module.exports = { nativeSourceDigest };
if (require.main === module) {
  process.stdout.write(`${nativeSourceDigest(path.resolve(process.argv[2]))}\n`);
}
