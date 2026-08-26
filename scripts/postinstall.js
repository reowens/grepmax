#!/usr/bin/env node
/**
 * Postinstall intentionally does not modify user-home agent configuration.
 * Users can install or update integrations explicitly with:
 *
 *   gmax plugin add
 *   gmax plugin update
 *
 * It does one other thing: overlay a vendored @lancedb/lancedb build if one
 * is present under ~/.gmax/vendor/. The npm-published 0.38 line stopped at
 * 0.38.0-beta.3 (lance 11.0.0-beta.16), which predates the FTS incremental-
 * merge fix (lance-format/lance#8312, lance 11.0.0-beta.22). lancedb's
 * Node publish has been failing since 2026-08-22 (lancedb/lancedb#3036), so
 * the fix-bearing 0.38.0-beta.10 darwin-arm64 build was taken from lancedb's
 * own CI artifact and lives at:
 *
 *   ~/.gmax/vendor/lancedb-0.38.0-beta.10/{dist/, lancedb.darwin-arm64.node}
 *
 * lancedb's dist/native.js requires ./lancedb.darwin-arm64.node before the
 * platform package, so copying the whole dist/ plus the binary into the
 * installed package is a complete swap. No vendor dir → no-op.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VENDOR_DIR = path.join(
  process.env.GMAX_HOME || path.join(os.homedir(), ".gmax"),
  "vendor",
  "lancedb-0.38.0-beta.10",
);
const NATIVE = "lancedb.darwin-arm64.node";

function overlayLancedb() {
  if (process.env.GMAX_NO_VENDOR_LANCEDB === "1") return null;
  if (process.platform !== "darwin" || process.arch !== "arm64") return null;
  const srcDist = path.join(VENDOR_DIR, "dist");
  const srcNative = path.join(VENDOR_DIR, NATIVE);
  if (!fs.existsSync(srcDist) || !fs.existsSync(srcNative)) return null;

  // package.json is not in lancedb's `exports`, so resolve the main entry
  // and walk up to the package root.
  let target;
  try {
    let dir = path.dirname(
      require.resolve("@lancedb/lancedb", { paths: [path.join(__dirname, "..")] }),
    );
    while (!fs.existsSync(path.join(dir, "package.json"))) {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    target = fs.realpathSync(dir);
  } catch {
    return null;
  }
  const dstDist = path.join(target, "dist");
  fs.rmSync(dstDist, { recursive: true, force: true });
  fs.cpSync(srcDist, dstDist, { recursive: true });
  fs.copyFileSync(srcNative, path.join(dstDist, NATIVE));
  fs.writeFileSync(
    path.join(target, ".gmax-vendored"),
    "0.38.0-beta.10 darwin-arm64 (lance 11.0.0-beta.22) from ~/.gmax/vendor\n",
  );
  return target;
}

let overlaid = null;
try {
  overlaid = overlayLancedb();
} catch (err) {
  console.warn(`gmax: lancedb vendor overlay failed: ${err.message}`);
}

if (process.env.GMAX_POSTINSTALL_QUIET !== "1") {
  if (overlaid) {
    console.log(`gmax: vendored lancedb 0.38.0-beta.10 (FTS merge fix) -> ${overlaid}`);
  }
  console.log(
    "gmax installed. To install or update editor plugins, run: gmax plugin update",
  );
}
