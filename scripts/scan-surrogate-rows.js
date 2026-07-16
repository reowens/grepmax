#!/usr/bin/env node
// Read-only scan of the live LanceDB `chunks` table for surrogate/U+FFFD
// content (SC-003 follow-up, docs/stability-cycle-v0.26.2.md).
//
// Streams path+content and reports:
//   (a) rows containing lone UTF-16 surrogates — expected 0 always: the
//       Arrow JS write layer (TextEncoder in apache-arrow's Utf8Builder)
//       substitutes U+FFFD at write time, so ill-formed JS strings cannot
//       reach disk. A nonzero count means a new write path bypassed it.
//   (b) rows containing U+FFFD, grouped by project — candidates split into
//       "faithful" (the source file itself contains a literal U+FFFD) and
//       "split artifact" (splitByChars sliced an astral char mid-pair and
//       the chunker repaired it to U+FFFD — by design since v0.26.5, and
//       byte-identical to what pre-fix writes stored).
//
// Safe to run while the daemon is up (LanceDB snapshot reads, no lease).
// Usage: node scripts/scan-surrogate-rows.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lancedb = require("@lancedb/lancedb");

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

(async () => {
  const home = os.homedir();
  const registry = JSON.parse(
    fs.readFileSync(path.join(home, ".gmax", "projects.json"), "utf8"),
  );
  const roots = (registry.projects ?? registry).map((p) => p.root);

  const db = await lancedb.connect(path.join(home, ".gmax", "lancedb"));
  const tbl = await db.openTable("chunks");

  let rows = 0;
  let loneRows = 0;
  const lonePaths = new Set();
  const fffdRowsByPath = new Map();

  for await (const batch of tbl.query().select(["path", "content"])) {
    const paths = batch.getChild("path");
    const contents = batch.getChild("content");
    for (let i = 0; i < batch.numRows; i++) {
      rows++;
      const c = contents.get(i);
      if (c == null) continue;
      if (LONE_SURROGATE.test(c)) {
        loneRows++;
        lonePaths.add(paths.get(i));
      }
      if (c.includes("�")) {
        const p = paths.get(i);
        fffdRowsByPath.set(p, (fffdRowsByPath.get(p) ?? 0) + 1);
      }
    }
    if (rows % 50000 < batch.numRows)
      process.stderr.write(`  ...${rows} rows\n`);
  }

  console.log(`rows scanned: ${rows}`);
  console.log(`lone-surrogate rows: ${loneRows}${loneRows ? "  <-- INVARIANT VIOLATED, investigate the write path" : ""}`);
  for (const p of lonePaths) console.log(`  ${p}`);

  const totalFffd = [...fffdRowsByPath.values()].reduce((a, b) => a + b, 0);
  console.log(`U+FFFD rows: ${totalFffd} across ${fffdRowsByPath.size} paths`);
  for (const [p, n] of [...fffdRowsByPath.entries()].sort()) {
    let kind = "(file missing)";
    try {
      const src = fs.readFileSync(p, "utf8");
      kind = src.includes("�") ? "faithful (source has literal U+FFFD)" : "split artifact (astral char at chunk boundary)";
    } catch {}
    console.log(`  ${n}  ${p}  ${kind}`);
  }

  const byProject = new Map();
  for (const [p, n] of fffdRowsByPath) {
    const root =
      roots.find((r) => p.startsWith(r.endsWith("/") ? r : `${r}/`)) ??
      "(unregistered)";
    byProject.set(root, (byProject.get(root) ?? 0) + n);
  }
  for (const [root, n] of [...byProject.entries()].sort()) {
    console.log(`  ${root}: ${n} rows with U+FFFD`);
  }
})().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
