// Bounded offline diagnostic only. Never opens stores, models, sockets or subprocesses.
// Exit 0 means scoring completed, even if the exploratory quality gate fails; exit 2 means no usable lexical cases.
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { parseArgs } = require("node:util");
const { hash, parseFixture } = require("./eval-documents.cjs");

const LIMITS = Object.freeze({
  files: 512,
  totalBytes: 16777216,
  fileBytes: 2097152,
  chunks: 10000,
  tokenOccurrences: 1000000,
  heapMiB: 384,
});
const STOP = new Set(
  "a an and are as at be been being by can could did do does for from had has have how i if in into is it its may must no not of on or our out should so than that the their them there these they this to was were what when where which who why will with without would you your".split(
    " ",
  ),
);
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
};
function check(value, reason) {
  if (!value) throw new Error(reason);
}
function tokens(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => !STOP.has(t),
  );
}
function readBounded(file, limit, canonical = true) {
  if (canonical) check(fs.realpathSync(file) === file, "source_alias");
  const fd = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(fd);
    check(before.isFile() && before.size <= limit, "read_limit");
    const bytes = Buffer.alloc(before.size + 1);
    let n = 0;
    while (n < bytes.length) {
      const read = fs.readSync(fd, bytes, n, bytes.length - n, n);
      if (!read) break;
      n += read;
    }
    const after = fs.fstatSync(fd),
      current = fs.statSync(file);
    check(
      n === before.size &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        before.dev === current.dev &&
        before.ino === current.ino &&
        before.size === current.size &&
        before.mtimeMs === current.mtimeMs &&
        before.ctimeMs === current.ctimeMs &&
        (!canonical || fs.realpathSync(file) === file),
      "source_changed",
    );
    return bytes.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}
function filesIn(root, prefixes) {
  const files = new Set();
  let entries = 0;
  function walk(dir) {
    check(fs.realpathSync(dir) === dir, "source_alias");
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      check(++entries <= 20000, "entry_limit");
      check(!entry.isSymbolicLink(), "source_alias");
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.toLowerCase().endsWith(".md")) {
        check(entry.isFile() && inside(root, file), "invalid_source");
        files.add(path.relative(root, file));
        check(files.size <= LIMITS.files, "file_limit");
      }
    }
  }
  for (const prefix of prefixes) {
    check(
      typeof prefix === "string" &&
        prefix !== "." &&
        !path.isAbsolute(prefix) &&
        path.normalize(prefix) === prefix &&
        !prefix.split(path.sep).includes(".."),
      "invalid_prefix",
    );
    const dir = path.resolve(root, prefix);
    check(inside(root, dir), "invalid_prefix");
    walk(dir);
  }
  return [...files].sort();
}
function privateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
function snapshot(root, prefixes, destination) {
  root = fs.realpathSync(root);
  fs.mkdirSync(destination, { mode: 0o700 });
  const files = filesIn(root, prefixes),
    sources = new Map();
  let totalBytes = 0;
  for (const file of files) {
    const bytes = readBounded(path.join(root, file), LIMITS.fileBytes);
    totalBytes += bytes.length;
    check(totalBytes <= LIMITS.totalBytes, "byte_limit");
    const source = {
      file,
      sha256: hash(bytes),
      bytes: bytes.length,
      content: bytes.toString("utf8"),
      lines: bytes.toString("utf8").split("\n").length,
    };
    sources.set(file, source);
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  }
  check(
    JSON.stringify(filesIn(root, prefixes)) === JSON.stringify(files),
    "source_set_changed",
  );
  for (const file of files)
    check(
      hash(readBounded(path.join(root, file), LIMITS.fileBytes)) ===
        sources.get(file).sha256,
      "source_changed",
    );
  const manifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    root,
    prefixes,
    totalBytes,
    files: [...sources.values()].map(
      ({ content: _content, ...metadata }) => metadata,
    ),
  };
  privateJson(path.join(destination, "manifest.json"), manifest);
  return {
    sources,
    manifest,
    manifestSha256: hash(
      fs.readFileSync(path.join(destination, "manifest.json")),
    ),
  };
}
function buildIndex(sources, tokenLimit = LIMITS.tokenOccurrences) {
  // Explicit qualification allowance; ordinary evaluation keeps its frozen limit.
  check(
    tokenLimit === LIMITS.tokenOccurrences || tokenLimit === 1100000,
    "invalid_token_limit",
  );
  const chunks = [],
    postings = new Map();
  let tokenOccurrences = 0;
  for (const source of sources.values()) {
    const lines = source.content.split("\n");
    for (let start = 0; start < lines.length; start += 40) {
      const end = Math.min(start + 48, lines.length),
        words = tokens(lines.slice(start, end).join("\n"));
      tokenOccurrences += words.length;
      check(tokenOccurrences <= tokenLimit, "token_limit");
      const counts = new Map();
      for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
      const id = chunks.length;
      chunks.push({
        file: source.file,
        startLine: start + 1,
        endLine: end,
        sourceSha256: source.sha256,
        length: words.length,
      });
      check(chunks.length <= LIMITS.chunks, "chunk_limit");
      for (const [word, count] of counts) {
        if (!postings.has(word)) postings.set(word, []);
        postings.get(word).push([id, count]);
      }
      if (end === lines.length) break;
    }
  }
  return {
    chunks,
    postings,
    tokenOccurrences,
    averageLength: tokenOccurrences / Math.max(1, chunks.length),
  };
}
function lexical(index, query) {
  const scores = new Map(),
    n = index.chunks.length;
  for (const word of new Set(tokens(query))) {
    const rows = index.postings.get(word) ?? [],
      idf = Math.log(1 + (n - rows.length + 0.5) / (rows.length + 0.5));
    for (const [id, tf] of rows) {
      const norm =
        1.2 *
        (0.25 + (0.75 * index.chunks[id].length) / (index.averageLength || 1));
      scores.set(id, (scores.get(id) ?? 0) + (idf * tf * 2.2) / (tf + norm));
    }
  }
  return [...scores]
    .filter(([, score]) => score > 0)
    .map(([id, score]) => ({ ...index.chunks[id], score }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
        a.startLine - b.startLine,
    )
    .slice(0, 50)
    .map((p, i) => ({ ...p, chunkRank: i + 1 }));
}
function distinct(pointers) {
  const ranks = new Map();
  for (const p of pointers)
    if (!ranks.has(p.file)) ranks.set(p.file, ranks.size + 1);
  return ranks;
}
function fuse(dense, lex) {
  const d = distinct(dense),
    l = distinct(lex),
    files = new Set([...d.keys(), ...l.keys()]);
  return [...files]
    .map((file) => {
      const dp = dense.find((p) => p.file === file),
        lp = lex.find((p) => p.file === file);
      const p = lp && (!dp || lp.chunkRank <= dp.chunkRank) ? lp : dp;
      return {
        ...p,
        denseDocumentRank: d.get(file) ?? 0,
        lexicalDocumentRank: l.get(file) ?? 0,
        score:
          (d.has(file) ? 1 / (60 + d.get(file)) : 0) +
          (l.has(file) ? 1 / (60 + l.get(file)) : 0),
        representativeArm: p === lp ? "lexical" : "archived_dense",
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
    )
    .slice(0, 50)
    .map((p, i) => ({ ...p, chunkRank: i + 1 }));
}
function grade(pointers, expected) {
  const ranks = distinct(pointers),
    targets = new Set(expected.map((t) => t.file));
  const hits = [...targets].map((f) => ranks.get(f) ?? 0).filter((r) => r > 0);
  const documentRank = hits.length ? Math.min(...hits) : 0;
  const section = pointers.findIndex((p) =>
    expected.some(
      (t) =>
        t.file === p.file &&
        p.startLine <= t.endLine &&
        p.endLine >= t.startLine,
    ),
  );
  const concentration = new Map();
  for (const p of pointers)
    concentration.set(p.file, (concentration.get(p.file) ?? 0) + 1);
  return {
    documentRank,
    documentRecallAt10:
      [...targets].filter((f) => (ranks.get(f) ?? Infinity) <= 10).length /
      targets.size,
    sectionRank: section < 0 ? 0 : section + 1,
    uniqueDocuments: ranks.size,
    maxChunksPerDocument: Math.max(0, ...concentration.values()),
    pointers,
  };
}
function archivedCase(archive, c, sources) {
  const rows = archive.samples.filter(
    (s) => s.id === c.id && s.arm === "narrow",
  );
  if (rows.length !== 1)
    return { exclusions: ["archive_missing_or_duplicate"] };
  const sample = rows[0];
  if (!Array.isArray(sample.exclusions))
    return { exclusions: ["archive_invalid_identity"] };
  if (
    sample.queryState !== "ready" ||
    sample.exclusions.length ||
    !sample.retrieval
  )
    return {
      exclusions: sample.exclusions?.length
        ? sample.exclusions.map((r) => `archive:${r}`)
        : [`archive:query:${sample.queryState}`],
    };
  if (
    !Number.isSafeInteger(sample.generation) ||
    sample.generation < 1 ||
    sample.project?.root !== archive.root ||
    typeof sample.project?.store !== "string" ||
    !path.isAbsolute(sample.project.store) ||
    path.resolve(sample.project.store) !== sample.project.store
  )
    return { exclusions: ["archive_invalid_identity"] };
  const pointers = sample.retrieval.pointers;
  if (!Array.isArray(pointers) || pointers.length > 50)
    return { exclusions: ["archive_invalid_pointers"] };
  for (const [i, p] of pointers.entries()) {
    const source = sources.get(p.file);
    if (
      !source ||
      !p.accepted ||
      p.hashAlgorithm !== "sha256-bytes" ||
      p.indexedSha256 !== source.sha256 ||
      p.currentSourceSha256 !== source.sha256 ||
      !Number.isSafeInteger(p.startLine) ||
      !Number.isSafeInteger(p.endLine) ||
      p.startLine < 1 ||
      p.endLine < p.startLine ||
      p.endLine > source.lines ||
      p.chunkRank !== i + 1
    )
      return { exclusions: ["archive_pointer_snapshot_mismatch"] };
  }
  return {
    exclusions: [],
    pointers: pointers.map((p) => ({
      file: p.file,
      startLine: p.startLine,
      endLine: p.endLine,
      sourceSha256: p.indexedSha256,
      score: p.score,
      chunkRank: p.chunkRank,
    })),
  };
}
function metric(rows, arm) {
  const values = rows.map((r) => r[arm]).filter(Boolean),
    count = values.length;
  const sum = (f) => values.reduce((n, r) => n + f(r), 0);
  return {
    cases: count,
    documentHitsAt10: sum((r) =>
      Number(r.documentRank > 0 && r.documentRank <= 10),
    ),
    documentMrrAt10: count
      ? sum((r) =>
          r.documentRank > 0 && r.documentRank <= 10 ? 1 / r.documentRank : 0,
        ) / count
      : null,
    documentRecallAt10: count ? sum((r) => r.documentRecallAt10) / count : null,
    sectionHitsAt10: sum((r) =>
      Number(r.sectionRank > 0 && r.sectionRank <= 10),
    ),
    sectionMrrAt10: count
      ? sum((r) =>
          r.sectionRank > 0 && r.sectionRank <= 10 ? 1 / r.sectionRank : 0,
        ) / count
      : null,
  };
}
function evaluate(fixture, archive, sources, index) {
  const cases = fixture.cases.map((c) => {
    const row = {
      id: c.id,
      exclusions: [],
      lexical: null,
      archivedDense: null,
      fused: null,
    };
    if (
      c.expected.some((t) => {
        const s = sources.get(t.file);
        return !s || s.sha256 !== t.sourceSha256 || t.endLine > s.lines;
      })
    ) {
      row.exclusions.push("frozen_target_snapshot_mismatch");
      return row;
    }
    const start = performance.now(),
      lex = lexical(index, c.query);
    row.lexicalMs = performance.now() - start;
    row.lexical = grade(lex, c.expected);
    const dense = archivedCase(archive, c, sources);
    row.exclusions.push(...dense.exclusions);
    if (!dense.exclusions.length) {
      row.archivedDense = grade(dense.pointers, c.expected);
      row.fused = grade(fuse(dense.pointers, lex), c.expected);
    }
    return row;
  });
  const shared = cases.filter((c) => c.archivedDense && c.fused && c.lexical);
  const losses = shared
    .filter(
      (c) =>
        c.archivedDense.documentRank > 0 &&
        c.archivedDense.documentRank <= 10 &&
        !(c.fused.documentRank > 0 && c.fused.documentRank <= 10),
    )
    .map((c) => c.id);
  const residuals = ["redis-secret-config", "people-module-links"].map((id) => {
    const c = shared.find((c) => c.id === id);
    return {
      id,
      comparable: Boolean(c),
      recoveredAt10: Boolean(
        c && c.fused.documentRank > 0 && c.fused.documentRank <= 10,
      ),
    };
  });
  return {
    cases,
    summary: {
      lexicalAll: metric(cases, "lexical"),
      sharedCases: shared.length,
      sharedArchivedDense: metric(shared, "archivedDense"),
      sharedLexical: metric(shared, "lexical"),
      sharedFused: metric(shared, "fused"),
      archivedTop10Losses: losses,
      residuals,
      exploratoryGate:
        shared.length > 0 &&
        losses.length === 0 &&
        residuals.every((r) => r.recoveredAt10)
          ? "pass"
          : "not_met",
    },
  };
}
function validatePlan(plan, fixture, archiveBytes) {
  check(
    JSON.stringify(plan.limits) === JSON.stringify(LIMITS),
    "plan_limits_mismatch",
  );
  check(
    plan.createdBeforeScoring === true &&
      plan.queryChanges === false &&
      plan.targetChanges === false &&
      plan.tuningAfterScoring === false &&
      Number.isFinite(Date.parse(plan.createdAt)) &&
      Date.parse(plan.createdAt) <= Date.now(),
    "invalid_plan",
  );
  check(plan.archiveSha256 === hash(archiveBytes), "archive_checksum_mismatch");
  check(
    plan.lexical.chunkLines === 48 &&
      plan.lexical.overlapLines === 8 &&
      plan.lexical.bm25K1 === 1.2 &&
      plan.lexical.bm25B === 0.75 &&
      plan.lexical.candidateChunks === 50 &&
      plan.fusion.constant === 60 &&
      JSON.stringify(plan.fusion.armWeights) === "[1,1]",
    "plan_algorithm_mismatch",
  );
  const root = fs.realpathSync(plan.root);
  check(root === plan.root, "root_alias");
  for (const p of plan.prefixes)
    check(
      fixture.prefixes.some((b) =>
        inside(path.resolve(root, b), path.resolve(root, p)),
      ),
      "scope_broadened",
    );
  for (const c of fixture.cases)
    for (const t of c.expected)
      check(
        plan.prefixes.some((p) =>
          inside(path.resolve(root, p), path.resolve(root, t.file)),
        ),
        "target_out_of_scope",
      );
}
async function main() {
  const { values } = parseArgs({
    options: {
      fixture: { type: "string" },
      plan: { type: "string" },
      "plan-sha256": { type: "string" },
      archive: { type: "string" },
      snapshot: { type: "string" },
      output: { type: "string" },
    },
  });
  for (const key of [
    "fixture",
    "plan",
    "plan-sha256",
    "archive",
    "snapshot",
    "output",
  ])
    check(values[key], "missing_argument");
  const planBytes = readBounded(path.resolve(values.plan), 1024 * 1024);
  check(hash(planBytes) === values["plan-sha256"], "plan_checksum_mismatch");
  const plan = JSON.parse(planBytes.toString("utf8")),
    fixture = parseFixture(
      readBounded(path.resolve(values.fixture), 1024 * 1024),
      plan.fixtureSha256,
    ),
    archiveBytes = readBounded(path.resolve(values.archive), 4 * 1024 * 1024),
    archive = JSON.parse(archiveBytes.toString("utf8"));
  check(
    archive.fixtureSha256 === plan.fixtureSha256 &&
      archive.root === plan.root &&
      JSON.stringify(archive.prefixes?.narrow) ===
        JSON.stringify(plan.prefixes.map((p) => path.resolve(plan.root, p))),
    "archive_scope_mismatch",
  );
  validatePlan(plan, fixture, archiveBytes);
  const fd = fs.openSync(values.output, "wx", 0o600);
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    planSha256: hash(planBytes),
    fixtureSha256: plan.fixtureSha256,
    archiveSha256: hash(archiveBytes),
    runnerSha256: hash(fs.readFileSync(__filename)),
    evaluatorSha256: hash(
      fs.readFileSync(require.resolve("./eval-documents.cjs")),
    ),
    limits: plan.limits,
    scope: plan.prefixes,
    mode: "offline_lexical_with_archived_dense_candidate_replay",
    error: null,
  };
  try {
    const captured = snapshot(plan.root, plan.prefixes, values.snapshot),
      index = buildIndex(captured.sources);
    report.snapshot = {
      manifestSha256: captured.manifestSha256,
      files: captured.sources.size,
      bytes: captured.manifest.totalBytes,
      chunks: index.chunks.length,
      tokenOccurrences: index.tokenOccurrences,
    };
    Object.assign(report, evaluate(fixture, archive, captured.sources, index));
    report.outcome = report.summary.lexicalAll.cases
      ? "quality_measured"
      : "no_usable_lexical_cases";
    if (!report.summary.lexicalAll.cases) process.exitCode = 2;
    report.peakRssKiB = process.resourceUsage().maxRSS;
    report.heapUsedBytes = process.memoryUsage().heapUsed;
    report.caveats = plan.confounds;
    report.sectionMetricWarning =
      "Diagnostic overlap only: lexical windows and hybrid representative selection differ from production dense chunking.";
    report.gateMeaning =
      "Exploratory archive replay only; a pass authorizes proposing matched production/consumer qualification, not deploying ranking changes.";
  } catch {
    report.error = "offline_evaluation_failed";
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeSync(fd, `${JSON.stringify(report, null, 2)}\n`);
    fs.closeSync(fd);
  }
  console.log(
    JSON.stringify({
      error: report.error,
      snapshot: report.snapshot,
      summary: report.summary,
    }),
  );
}
module.exports = {
  LIMITS,
  tokens,
  readBounded,
  filesIn,
  snapshot,
  buildIndex,
  lexical,
  fuse,
  grade,
  archivedCase,
  evaluate,
  validatePlan,
};
if (require.main === module)
  main().catch(() => {
    console.error("offline_evaluation_preflight_failed");
    process.exitCode = 1;
  });
