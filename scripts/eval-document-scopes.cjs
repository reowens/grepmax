// Counterbalanced scope ablation: identical frozen queries/targets, existing-only MCP.
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const e = require("./eval-documents.cjs");

function scopes(fixture, treatment, root) {
  if (!Array.isArray(treatment) || !treatment.length || treatment.length > 32)
    throw new Error("invalid_scopes");
  // Reuse all fixture path/range validation; only the prefixes change.
  const bytes = Buffer.from(
    JSON.stringify({ ...fixture, prefixes: treatment }),
  );
  e.parseFixture(bytes, e.hash(bytes));
  const resolve = (prefixes) =>
    prefixes.map((p) => {
      const absolute = path.resolve(root, p);
      if (fs.realpathSync(absolute) !== absolute)
        throw new Error("scope_alias");
      return absolute;
    });
  const broad = resolve(fixture.prefixes),
    narrow = resolve(treatment);
  if (
    !narrow.every((n) =>
      broad.some((b) => {
        const rel = path.relative(b, n);
        return (
          rel === "" ||
          (rel !== ".." &&
            !rel.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(rel))
        );
      }),
    )
  )
    throw new Error("treatment_broadens_scope");
  return { broad, narrow };
}

function pairSummary(samples, plannedPairs) {
  const groups = new Map();
  for (const s of samples) {
    if (!groups.has(s.id)) groups.set(s.id, {});
    const pair = groups.get(s.id);
    if (!["broad", "narrow"].includes(s.arm) || pair[s.arm])
      throw new Error("duplicate_arm");
    pair[s.arm] = s;
  }
  const valid = (s) =>
    s && s.queryState === "ready" && s.retrieval && !s.exclusions.length;
  const pairs = [...groups].map(([id, pair]) => {
    const reasons = [];
    if (!valid(pair.broad)) reasons.push("broad_unusable");
    if (!valid(pair.narrow)) reasons.push("narrow_unusable");
    if (valid(pair.broad) && valid(pair.narrow)) {
      if (
        !Number.isSafeInteger(pair.broad.generation) ||
        pair.broad.generation <= 0 ||
        pair.broad.generation !== pair.narrow.generation
      )
        reasons.push("generation_changed_between_arms");
      if (
        !pair.broad.project ||
        !pair.narrow.project ||
        typeof pair.broad.project.root !== "string" ||
        typeof pair.broad.project.store !== "string" ||
        !pair.broad.project.root ||
        !pair.broad.project.store ||
        pair.broad.project.root !== pair.narrow.project.root ||
        pair.broad.project.store !== pair.narrow.project.store
      )
        reasons.push("project_changed_between_arms");
    }
    return {
      id,
      valid: !reasons.length,
      reasons,
      broadRank: pair.broad?.retrieval?.verifiedDocumentRank ?? null,
      narrowRank: pair.narrow?.retrieval?.verifiedDocumentRank ?? null,
    };
  });
  const sharedIds = new Set(pairs.filter((p) => p.valid).map((p) => p.id));
  const cohort = (arm, shared) =>
    e.summarize(
      samples.filter((s) => s.arm === arm && (!shared || sharedIds.has(s.id))),
    );
  return {
    plannedPairs,
    completedPairs: pairs.filter(
      (p) => groups.get(p.id).broad && groups.get(p.id).narrow,
    ).length,
    comparablePairs: sharedIds.size,
    comparableFraction: sharedIds.size / plannedPairs,
    standalone: {
      broad: cohort("broad", false),
      narrow: cohort("narrow", false),
    },
    shared: { broad: cohort("broad", true), narrow: cohort("narrow", true) },
    pairs,
  };
}

async function runPairs({
  fixture,
  root,
  prefixes,
  client,
  onSample,
  gapMs = 1000,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const samples = [];
  for (let i = 0; i < fixture.cases.length; i++) {
    if (i && gapMs) await pause(gapMs);
    // Alternate arm order per case. Never retry a refused query or initialize resources.
    const order = i % 2 ? ["narrow", "broad"] : ["broad", "narrow"];
    for (const arm of order) {
      const sample = await e.evaluateCase({
        root,
        prefixes: prefixes[arm],
        c: fixture.cases[i],
        client,
        repetition: 1,
      });
      sample.arm = arm;
      sample.orderWithinPair = order.indexOf(arm) + 1;
      samples.push(sample);
      onSample(sample);
    }
  }
  return samples;
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixture: { type: "string" },
      sha256: { type: "string" },
      root: { type: "string" },
      entry: { type: "string" },
      output: { type: "string" },
      "narrow-prefix": { type: "string", multiple: true },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/eval-document-scopes.cjs --fixture <frozen-json> --sha256 <digest> --root <project> --entry <installed/dist/bin.js> --output <new-json> --narrow-prefix <relative-directory> [--narrow-prefix <directory>]",
    );
    return;
  }
  for (const key of [
    "fixture",
    "sha256",
    "root",
    "entry",
    "output",
    "narrow-prefix",
  ])
    if (!values[key]) throw new Error("missing_argument");
  const fixture = e.parseFixture(
    fs.readFileSync(values.fixture),
    values.sha256,
  );
  const root = fs.realpathSync(values.root),
    entry = fs.realpathSync(values.entry);
  const prefixes = scopes(fixture, values["narrow-prefix"], root);
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    fixtureSha256: values.sha256,
    runnerSha256: e.hash(fs.readFileSync(__filename)),
    evaluatorSha256: e.hash(
      fs.readFileSync(require.resolve("./eval-documents.cjs")),
    ),
    entrySha256: e.hash(fs.readFileSync(entry)),
    root,
    entry,
    prefixes,
    gapMs: 1000,
    samples: [],
    error: null,
    limits: [
      "Source-curated development fixture; scope selected from known target families, not general recall.",
      "Adjacent alternating arm order reduces scheduling confounding; live corpus/background load can still change.",
      "Compare quality only on the shared usable cohort with identical resource generation/project/store.",
      "Refusals are observations, never retried; no warmup, startup, indexing, model setup, fallback or policy changes.",
    ],
  };
  const output = fs.openSync(values.output, "wx", 0o600);
  let checkpoint, client;
  try {
    checkpoint = fs.openSync(`${values.output}.samples.jsonl`, "wx", 0o600);
    client = new e.StdioClient(entry, root);
    const hello = await client.initialize();
    report.server = {
      name: hello.serverInfo.name,
      protocolVersion: hello.protocolVersion,
    };
    await runPairs({
      fixture,
      root,
      prefixes,
      client,
      onSample: (sample) => {
        report.samples.push(sample);
        fs.writeSync(checkpoint, JSON.stringify(sample) + "\n");
        console.log(
          JSON.stringify({
            id: sample.id,
            arm: sample.arm,
            state: sample.queryState,
            rank: sample.retrieval?.verifiedDocumentRank ?? null,
            exclusions: sample.exclusions,
          }),
        );
      },
    });
  } catch {
    report.error = "scope_evaluation_failed";
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
    if (checkpoint !== undefined) fs.closeSync(checkpoint);
    report.finishedAt = new Date().toISOString();
    report.stderrBytes = client?.stderrBytes ?? 0;
    report.summary = pairSummary(report.samples, fixture.cases.length);
    if (!report.error && !report.summary.comparablePairs) process.exitCode = 2;
    fs.writeSync(output, JSON.stringify(report, null, 2) + "\n");
    fs.closeSync(output);
    console.log(
      JSON.stringify({
        error: report.error,
        comparablePairs: report.summary.comparablePairs,
        broad: report.summary.shared.broad,
        narrow: report.summary.shared.narrow,
      }),
    );
  }
}

module.exports = { scopes, pairSummary, runPairs };
if (require.main === module)
  main().catch(() => {
    console.error("scope_evaluation_preflight_failed");
    process.exitCode = 1;
  });
