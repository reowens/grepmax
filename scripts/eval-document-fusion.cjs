// Repo-only qualification. Live mode uses only the released existing-only MCP.
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const e = require("./eval-documents.cjs");
const l = require("./eval-document-lexical.cjs");

function requireValue(value, reason) {
  if (!value) throw new Error(reason);
}

function protectedFusion(dense, lexical) {
  const first = (rows) =>
    [...new Map(rows.map((p) => [p.file, null])).keys()]
      .map((file) => rows.find((p) => p.file === file))
      .slice(0, 3);
  const arms = [first(lexical), first(dense)],
    output = [],
    seen = new Set();
  const append = (p, selection) => {
    if (!p || seen.has(p.file)) return;
    seen.add(p.file);
    output.push({ ...p, selection, chunkRank: output.length + 1 });
  };
  for (let rank = 0; rank < 3; rank++) {
    append(arms[0][rank], "lexical_anchor");
    append(arms[1][rank], "dense_anchor");
  }
  for (const p of l.fuse(dense, lexical)) {
    if (output.length === 50) break;
    append(p, "rrf_tail");
  }
  return output;
}

function verifiedPointers(rows, sources) {
  requireValue(Array.isArray(rows) && rows.length <= 50, "invalid_candidates");
  return rows.map((p, i) => {
    const source = sources.get(p.file);
    requireValue(
      source &&
        p.sourceSha256 === source.sha256 &&
        Number.isSafeInteger(p.startLine) &&
        Number.isSafeInteger(p.endLine) &&
        p.startLine > 0 &&
        p.endLine >= p.startLine &&
        p.endLine <= source.lines &&
        p.chunkRank === i + 1 &&
        Number.isFinite(p.score),
      "candidate_snapshot_mismatch",
    );
    return {
      file: p.file,
      sourceSha256: p.sourceSha256,
      startLine: p.startLine,
      endLine: p.endLine,
      score: p.score,
      chunkRank: p.chunkRank,
    };
  });
}

function gradeCase(c, dense, lexical) {
  return {
    id: c.id,
    dense: l.grade(dense, c.expected),
    lexical: l.grade(lexical, c.expected),
    rrf: l.grade(l.fuse(dense, lexical), c.expected),
    protected: l.grade(protectedFusion(dense, lexical), c.expected),
  };
}

function summary(rows, planned, minimum) {
  const usable = rows.filter((r) => r.protected && !r.exclusions.length);
  const metric = (arm) => {
    const hits = usable.filter(
      (r) => r[arm].documentRank > 0 && r[arm].documentRank <= 10,
    );
    return {
      cases: usable.length,
      documentHitsAt10: hits.length,
      documentRecallAt10: usable.length
        ? usable.reduce((n, r) => n + r[arm].documentRecallAt10, 0) /
          usable.length
        : null,
      documentMrrAt10: usable.length
        ? hits.reduce((n, r) => n + 1 / r[arm].documentRank, 0) / usable.length
        : null,
    };
  };
  const lostTargets = (baseline) =>
    usable.flatMap((r) => {
      const rank = (arm) =>
        new Map(
          [...new Set(r[arm].pointers.map((p) => p.file))].map((f, i) => [
            f,
            i + 1,
          ]),
        );
      const before = rank(baseline),
        after = rank("protected");
      return r.expectedFiles
        .filter(
          (f) =>
            (before.get(f) ?? Infinity) <= 10 &&
            (after.get(f) ?? Infinity) > 10,
        )
        .map((file) => ({ id: r.id, file }));
    });
  const denseLosses = lostTargets("dense"),
    lexicalLosses = lostTargets("lexical");
  const metrics = Object.fromEntries(
    ["dense", "lexical", "rrf", "protected"].map((a) => [a, metric(a)]),
  );
  const exclusionCounts = {};
  for (const row of rows)
    for (const reason of row.exclusions)
      exclusionCounts[reason] = (exclusionCounts[reason] ?? 0) + 1;
  const enough =
    usable.length > 0 && usable.length >= minimum && rows.length === planned;
  return {
    plannedCases: planned,
    completedCases: rows.length,
    comparableCases: usable.length,
    metrics,
    denseTop10TargetLosses: denseLosses,
    lexicalTop10TargetLosses: lexicalLosses,
    exclusionCounts,
    evidenceSufficient: enough,
    gate: !enough
      ? "insufficient_evidence"
      : denseLosses.length ||
          metrics.protected.documentRecallAt10 <
            Math.max(
              metrics.dense.documentRecallAt10,
              metrics.lexical.documentRecallAt10,
            )
        ? "not_met"
        : "pass",
  };
}

function validateDesign(design, fixture) {
  requireValue(
    Number.isSafeInteger(design.newCohort?.plannedCases) &&
      design.newCohort.plannedCases > 0 &&
      Number.isSafeInteger(design.newCohort.minimumComparableCases) &&
      design.newCohort.minimumComparableCases > 0 &&
      design.newCohort.minimumComparableCases <= design.newCohort.plannedCases,
    "invalid_cohort_bounds",
  );
  requireValue(
    design.frozenBeforeNewQuestions === true &&
      design.tuningAfterScoring === false &&
      Number.isFinite(Date.parse(design.createdAt)) &&
      Date.parse(design.createdAt) <= Date.now(),
    "invalid_design",
  );
  requireValue(
    JSON.stringify(design.parameters) ===
      JSON.stringify({
        anchorsPerArm: 3,
        armOrder: ["lexical", "dense"],
        rrfConstant: 60,
        outputDocuments: 50,
        lexicalWindowLines: 48,
        lexicalOverlapLines: 8,
        bm25K1: 1.2,
        bm25B: 0.75,
        lexicalChunkCandidates: 50,
      }) &&
      [l.LIMITS, { ...l.LIMITS, tokenOccurrences: 1100000 }].some(
        (limits) => JSON.stringify(design.limits) === JSON.stringify(limits),
      ),
    "design_algorithm_mismatch",
  );
  requireValue(
    design.root === fs.realpathSync(design.root) &&
      Array.isArray(design.prefixes) &&
      design.prefixes.length > 0 &&
      design.prefixes.length <= 32,
    "invalid_design_scope",
  );
  const inside = (parent, child) =>
    child === parent || child.startsWith(parent + path.sep);
  for (const p of design.prefixes)
    requireValue(
      typeof p === "string" &&
        p !== "." &&
        !path.isAbsolute(p) &&
        path.normalize(p) === p &&
        !p.split(path.sep).includes("..") &&
        fixture.prefixes.some((f) =>
          inside(path.resolve(design.root, f), path.resolve(design.root, p)),
        ),
      "design_scope_broadened",
    );
  for (const c of fixture.cases)
    for (const t of c.expected)
      requireValue(
        design.prefixes.some((p) =>
          inside(
            path.resolve(design.root, p),
            path.resolve(design.root, t.file),
          ),
        ),
        "target_out_of_scope",
      );
}

function readSnapshot(directory, manifestSha256) {
  const root = path.resolve(directory);
  requireValue(root === fs.realpathSync(root), "snapshot_alias");
  const bytes = l.readBounded(path.join(root, "manifest.json"), 1024 * 1024);
  requireValue(e.hash(bytes) === manifestSha256, "manifest_checksum_mismatch");
  const manifest = JSON.parse(bytes),
    sources = new Map();
  const actual = l.filesIn(root, manifest.prefixes);
  requireValue(
    JSON.stringify(actual) ===
      JSON.stringify(manifest.files.map((f) => f.file)),
    "snapshot_set_mismatch",
  );
  let total = 0;
  for (const f of manifest.files) {
    const body = l.readBounded(path.join(root, f.file), l.LIMITS.fileBytes);
    total += body.length;
    requireValue(
      total <= l.LIMITS.totalBytes &&
        e.hash(body) === f.sha256 &&
        body.length === f.bytes &&
        body.toString("utf8").split("\n").length === f.lines,
      "snapshot_digest_mismatch",
    );
    sources.set(f.file, { ...f, content: body.toString("utf8") });
  }
  requireValue(total === manifest.totalBytes, "snapshot_total_mismatch");
  return { manifest, sources };
}

function targetsCurrent(c, sources) {
  return c.expected.every(
    (t) =>
      sources.get(t.file)?.sha256 === t.sourceSha256 &&
      t.endLine <= sources.get(t.file).lines,
  );
}

function replay(fixture, input, sources) {
  requireValue(
    input.fixtureSha256 && Array.isArray(input.cases),
    "invalid_replay",
  );
  return fixture.cases.map((c) => {
    const rows = input.cases.filter((r) => r.id === c.id);
    requireValue(rows.length === 1, "replay_missing_or_duplicate");
    const saved = rows[0],
      base = {
        id: c.id,
        expectedFiles: [...new Set(c.expected.map((t) => t.file))],
        exclusions: [],
      };
    if (!targetsCurrent(c, sources))
      return { ...base, exclusions: ["frozen_target_snapshot_mismatch"] };
    if (!Array.isArray(saved.exclusions)) throw new Error("invalid_replay");
    if (saved.exclusions.length || !saved.archivedDense || !saved.lexical)
      return {
        ...base,
        exclusions: saved.exclusions.length
          ? saved.exclusions
          : ["replay_unavailable"],
      };
    try {
      return {
        ...base,
        ...gradeCase(
          c,
          verifiedPointers(saved.archivedDense.pointers, sources),
          verifiedPointers(saved.lexical.pointers, sources),
        ),
      };
    } catch {
      return { ...base, exclusions: ["candidate_snapshot_mismatch"] };
    }
  });
}

async function collect({
  fixture,
  design,
  sources,
  index,
  client,
  onRow,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const rows = [];
  for (const [i, c] of fixture.cases.entries()) {
    if (i) await pause(1000);
    const base = {
      id: c.id,
      expectedFiles: [...new Set(c.expected.map((t) => t.file))],
      exclusions: [],
    };
    let row;
    if (!targetsCurrent(c, sources))
      row = { ...base, exclusions: ["frozen_target_snapshot_mismatch"] };
    else {
      const sample = await e.evaluateCase({
        root: design.root,
        prefixes: design.prefixes.map((p) => path.join(design.root, p)),
        c,
        client,
        repetition: 1,
      });
      row = { ...base, sample, exclusions: [...sample.exclusions] };
      if (!row.exclusions.length) {
        const candidates = l.archivedCase(
          { root: design.root, samples: [{ ...sample, arm: "narrow" }] },
          c,
          sources,
        );
        row.exclusions.push(...candidates.exclusions);
        if (!row.exclusions.length)
          Object.assign(
            row,
            gradeCase(c, candidates.pointers, l.lexical(index, c.query)),
          );
      }
    }
    rows.push(row);
    onRow(row);
  }
  return rows;
}

function snapshotStillCurrent(design, captured) {
  try {
    return (
      JSON.stringify(l.filesIn(design.root, design.prefixes)) ===
        JSON.stringify(captured.manifest.files.map((f) => f.file)) &&
      captured.manifest.files.every(
        (f) =>
          e.hash(
            l.readBounded(path.join(design.root, f.file), l.LIMITS.fileBytes),
          ) === f.sha256,
      )
    );
  } catch {
    return false;
  }
}

async function main() {
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        "mode",
        "design",
        "design-sha256",
        "fixture",
        "fixture-sha256",
        "input",
        "input-sha256",
        "entry",
        "entry-sha256",
        "snapshot",
        "output",
      ].map((k) => [k, { type: "string" }]),
    ),
  });
  for (const k of [
    "mode",
    "design",
    "design-sha256",
    "fixture",
    "fixture-sha256",
    "snapshot",
    "output",
  ])
    requireValue(values[k], "missing_argument");
  requireValue(["replay", "live"].includes(values.mode), "invalid_mode");
  const designBytes = l.readBounded(path.resolve(values.design), 1024 * 1024);
  requireValue(
    e.hash(designBytes) === values["design-sha256"],
    "design_checksum_mismatch",
  );
  const design = JSON.parse(designBytes),
    fixture = e.parseFixture(
      l.readBounded(path.resolve(values.fixture), 1024 * 1024),
      values["fixture-sha256"],
    );
  validateDesign(design, fixture);
  let input, captured;
  if (values.mode === "replay") {
    requireValue(values.input && values["input-sha256"], "missing_input");
    const bytes = l.readBounded(path.resolve(values.input), 4 * 1024 * 1024);
    requireValue(
      e.hash(bytes) === values["input-sha256"],
      "input_checksum_mismatch",
    );
    input = JSON.parse(bytes);
    requireValue(
      input.fixtureSha256 === values["fixture-sha256"],
      "replay_fixture_mismatch",
    );
    captured = readSnapshot(values.snapshot, input.snapshot.manifestSha256);
    requireValue(
      captured.manifest.root === design.root,
      "replay_root_mismatch",
    );
  } else {
    requireValue(
      values.entry &&
        values["entry-sha256"] &&
        fixture.cases.length === design.newCohort.plannedCases,
      "invalid_live_arguments",
    );
    requireValue(
      e.hash(l.readBounded(path.resolve(values.entry), 2 * 1024 * 1024)) ===
        values["entry-sha256"],
      "entry_checksum_mismatch",
    );
  }
  const fd = fs.openSync(values.output, "wx", 0o600),
    report = {
      schemaVersion: 1,
      mode: values.mode,
      startedAt: new Date().toISOString(),
      designSha256: values["design-sha256"],
      fixtureSha256: values["fixture-sha256"],
      inputSha256: values["input-sha256"] ?? null,
      entrySha256: values["entry-sha256"] ?? null,
      runnerSha256: e.hash(fs.readFileSync(__filename)),
      evaluatorSha256: e.hash(
        fs.readFileSync(require.resolve("./eval-documents.cjs")),
      ),
      lexicalEvaluatorSha256: e.hash(
        fs.readFileSync(require.resolve("./eval-document-lexical.cjs")),
      ),
      rows: [],
      error: null,
      caveats: design.limitations,
    };
  let client, checkpoint;
  try {
    if (values.mode === "replay") {
      report.snapshot = {
        manifestSha256: input.snapshot.manifestSha256,
        files: captured.sources.size,
        bytes: captured.manifest.totalBytes,
      };
      report.rows = replay(fixture, input, captured.sources);
    } else {
      checkpoint = fs.openSync(values.output + ".samples.jsonl", "wx", 0o600);
      captured = l.snapshot(design.root, design.prefixes, values.snapshot);
      const index = l.buildIndex(
        captured.sources,
        design.limits.tokenOccurrences,
      );
      report.snapshot = {
        manifestSha256: captured.manifestSha256,
        files: captured.sources.size,
        bytes: captured.manifest.totalBytes,
        chunks: index.chunks.length,
        tokenOccurrences: index.tokenOccurrences,
      };
      client = new e.StdioClient(fs.realpathSync(values.entry), design.root);
      const hello = await client.initialize();
      report.server = {
        name: hello.serverInfo.name,
        protocolVersion: hello.protocolVersion,
      };
      await collect({
        fixture,
        design,
        sources: captured.sources,
        index,
        client,
        onRow: (r) => {
          report.rows.push(r);
          fs.writeSync(checkpoint, JSON.stringify(r) + "\n");
          console.log(
            JSON.stringify({
              id: r.id,
              state: r.sample?.queryState ?? "excluded",
              exclusions: r.exclusions,
            }),
          );
        },
      });
      report.snapshotCurrentAtEnd = snapshotStillCurrent(design, captured);
      if (!report.snapshotCurrentAtEnd)
        for (const row of report.rows)
          row.exclusions.push("corpus_changed_during_collection");
    }
  } catch {
    report.error = "fusion_qualification_failed";
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
    if (checkpoint !== undefined) fs.closeSync(checkpoint);
    report.finishedAt = new Date().toISOString();
    report.stderrBytes = client?.stderrBytes ?? 0;
    report.peakRssKiB = process.resourceUsage().maxRSS;
    report.summary = summary(
      report.rows,
      fixture.cases.length,
      values.mode === "live"
        ? design.newCohort.minimumComparableCases
        : input.cases.filter(
            (r) => r.archivedDense && r.lexical && !r.exclusions.length,
          ).length,
    );
    if (values.mode === "replay") {
      report.summary.residuals = [
        "redis-secret-config",
        "people-module-links",
      ].map((id) => {
        const r = report.rows.find((r) => r.id === id);
        return {
          id,
          rank:
            r && !r.exclusions.length
              ? (r.protected?.documentRank ?? null)
              : null,
        };
      });
      if (report.summary.residuals.some((r) => r.rank === null))
        report.summary.gate = "insufficient_evidence";
      else if (
        !report.summary.residuals.every((r) => r.rank > 0 && r.rank <= 10)
      )
        report.summary.gate = "not_met";
    }
    if (report.error) report.summary.gate = "interrupted";
    else if (!report.summary.comparableCases) process.exitCode = 2;
    fs.writeSync(fd, JSON.stringify(report, null, 2) + "\n");
    fs.closeSync(fd);
    console.log(
      JSON.stringify({ error: report.error, summary: report.summary }),
    );
  }
}
module.exports = {
  protectedFusion,
  verifiedPointers,
  gradeCase,
  summary,
  validateDesign,
  readSnapshot,
  targetsCurrent,
  replay,
  collect,
  snapshotStillCurrent,
};
if (require.main === module)
  main().catch(() => {
    console.error("fusion_qualification_preflight_failed");
    process.exitCode = 1;
  });
