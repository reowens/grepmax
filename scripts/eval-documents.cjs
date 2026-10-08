// Document retrieval evaluation: built-ins only, released existing-only MCP only.
// No daemon/store/model imports, autostart, warmup, retries or source-body output.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { parseArgs } = require("node:util");

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const FRAME_BYTES = 1024 * 1024;
const STATES = new Set([
  "ready",
  "unsupported_tool",
  "unsupported_daemon",
  "no_index",
  "index_unavailable",
  "daemon_unavailable",
  "store_unavailable",
  "embedding_unavailable",
  "embedding_mismatch",
  "host_pressure",
  "busy",
  "cancelled",
  "timeout",
  "no_coverage",
  "search_unavailable",
]);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
};
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const digest = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
function requireValue(value, reason) {
  if (!value) throw new Error(reason);
}
function relative(s) {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    !path.isAbsolute(s) &&
    !s.includes("\0") &&
    !s.includes("\\") &&
    !s.split("/").includes("..") &&
    path.normalize(s) === s &&
    s !== "."
  );
}

function parseFixture(bytes, checksum) {
  requireValue(
    digest(checksum) && hash(bytes) === checksum,
    "fixture_checksum_mismatch",
  );
  const fixture = JSON.parse(bytes.toString("utf8"));
  requireValue(
    fixture.schemaVersion === 1 && typeof fixture.purpose === "string",
    "invalid_fixture",
  );
  requireValue(
    Array.isArray(fixture.prefixes) &&
      fixture.prefixes.length > 0 &&
      fixture.prefixes.length <= 32 &&
      fixture.prefixes.every(relative),
    "invalid_prefixes",
  );
  requireValue(
    Array.isArray(fixture.cases) &&
      fixture.cases.length > 0 &&
      fixture.cases.length <= 100,
    "invalid_cases",
  );
  requireValue(
    new Set(fixture.cases.map((c) => c.id)).size === fixture.cases.length,
    "duplicate_case_id",
  );
  for (const c of fixture.cases) {
    requireValue(
      typeof c.id === "string" && /^[a-z0-9-]{1,80}$/.test(c.id),
      "invalid_case_id",
    );
    requireValue(
      typeof c.query === "string" &&
        c.query.trim().length > 0 &&
        c.query.length <= 500,
      "invalid_query",
    );
    requireValue(
      Array.isArray(c.expected) &&
        c.expected.length > 0 &&
        c.expected.length <= 32,
      "invalid_targets",
    );
    for (const t of c.expected) {
      requireValue(
        relative(t.file) &&
          t.file.toLowerCase().endsWith(".md") &&
          digest(t.sourceSha256),
        "invalid_target",
      );
      requireValue(
        positive(t.startLine) &&
          positive(t.endLine) &&
          t.endLine >= t.startLine,
        "invalid_target_range",
      );
      requireValue(
        fixture.prefixes.some((p) =>
          inside(path.resolve(p), path.resolve(t.file)),
        ),
        "target_out_of_scope",
      );
    }
  }
  return fixture;
}

function readSource(root, file) {
  const absolute = path.resolve(root, file);
  requireValue(
    inside(root, absolute) && fs.realpathSync(absolute) === absolute,
    "source_out_of_scope",
  );
  // Bound reads even if an actively edited file grows after stat. Do not persist bytes.
  const fd = fs.openSync(absolute, "r");
  try {
    const stat = fs.fstatSync(fd);
    requireValue(
      stat.isFile() && stat.size <= MAX_SOURCE_BYTES,
      "source_unreadable",
    );
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_SOURCE_BYTES + 1));
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!n) break;
      length += n;
    }
    requireValue(
      length === stat.size && fs.realpathSync(absolute) === absolute,
      "source_changed_during_read",
    );
    const after = fs.fstatSync(fd);
    requireValue(
      after.size === stat.size &&
        after.mtimeMs === stat.mtimeMs &&
        after.ctimeMs === stat.ctimeMs,
      "source_changed_during_read",
    );
    const current = fs.statSync(absolute);
    requireValue(
      current.dev === stat.dev &&
        current.ino === stat.ino &&
        current.mtimeMs === stat.mtimeMs &&
        current.size === stat.size,
      "source_changed_during_read",
    );
    const content = bytes.subarray(0, length);
    return {
      sha256: hash(content),
      lines: content.toString("utf8").split("\n").length,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function envelope(result) {
  requireValue(
    result && result.contractVersion === 1 && STATES.has(result.state),
    "invalid_contract",
  );
  requireValue(
    result.capabilities?.existingIndexOnly === 1 &&
      result.capabilities.queryLogging === false &&
      result.capabilities.watch === false &&
      result.capabilities.runtimeStartup === false,
    "invalid_capabilities",
  );
  if (result.state === "ready")
    requireValue(positive(result.generation), "invalid_generation");
  return result;
}

function targetChecks(root, c) {
  return c.expected.map((t) => {
    try {
      const source = readSource(root, t.file);
      return {
        file: t.file,
        ...source,
        reason:
          source.sha256 !== t.sourceSha256
            ? "source_changed"
            : source.lines < t.endLine
              ? "target_range_out_of_bounds"
              : null,
      };
    } catch {
      return { file: t.file, reason: "source_unreadable" };
    }
  });
}

function checkCoverage(root, status, c) {
  requireValue(
    fs.realpathSync(status.project.root) === root &&
      path.resolve(status.project.root) === root &&
      typeof status.project.store === "string" &&
      path.isAbsolute(status.project.store),
    "invalid_project",
  );
  requireValue(
    Array.isArray(status.covered) &&
      status.covered.length <= 2000 &&
      Number.isSafeInteger(status.coverage?.requested) &&
      Number.isSafeInteger(status.coverage?.indexed) &&
      typeof status.coverage?.partial === "boolean",
    "invalid_coverage",
  );
  const files = [...new Set(c.expected.map((t) => t.file))];
  requireValue(
    status.coverage.requested === files.length &&
      status.coverage.indexed === status.covered.length &&
      status.coverage.indexed <= files.length,
    "invalid_coverage",
  );
  const covered = new Map();
  for (const row of status.covered) {
    requireValue(
      typeof row.path === "string" && path.isAbsolute(row.path),
      "invalid_coverage",
    );
    const file = path.relative(root, row.path);
    requireValue(
      files.includes(file) &&
        !covered.has(file) &&
        path.resolve(root, file) === row.path,
      "invalid_coverage",
    );
    covered.set(file, row);
  }
  return files.map((file) => {
    const row = covered.get(file);
    const target = c.expected.find((t) => t.file === file);
    return {
      file,
      indexed: Boolean(row),
      hashCurrent:
        row?.hashAlgorithm === "sha256-bytes" &&
        row.hash === target.sourceSha256,
    };
  });
}

function grade(root, prefixes, c, status, result) {
  requireValue(
    result.root === status.project.root &&
      result.store === status.project.store,
    "project_changed",
  );
  requireValue(result.generation === status.generation, "generation_changed");
  requireValue(
    Array.isArray(result.matches) && result.matches.length <= 50,
    "invalid_matches",
  );
  const sources = new Map();
  const unique = new Map();
  const expectedFiles = new Set(c.expected.map((t) => t.file));
  let rawDocumentRank = 0,
    verifiedDocumentRank = 0,
    sectionRank = 0;
  const pointers = result.matches.map((row, index) => {
    requireValue(
      Object.keys(row).every((key) =>
        [
          "path",
          "startLine",
          "endLine",
          "score",
          "hash",
          "hashAlgorithm",
        ].includes(key),
      ),
      "unexpected_pointer_fields",
    );
    requireValue(
      typeof row.path === "string" &&
        path.isAbsolute(row.path) &&
        path.resolve(row.path) === row.path &&
        inside(root, row.path) &&
        prefixes.some((p) => inside(p, row.path)) &&
        row.path.toLowerCase().endsWith(".md") &&
        positive(row.startLine) &&
        positive(row.endLine) &&
        row.endLine >= row.startLine &&
        Number.isFinite(row.score) &&
        row.score >= 0 &&
        row.score <= 1,
      "invalid_pointer",
    );
    const file = path.relative(root, row.path);
    if (!unique.has(file)) unique.set(file, unique.size + 1);
    const documentRank = unique.get(file);
    if (!rawDocumentRank && expectedFiles.has(file))
      rawDocumentRank = documentRank;
    if (!sources.has(file)) {
      try {
        sources.set(file, readSource(root, file));
      } catch {
        sources.set(file, null);
      }
    }
    const source = sources.get(file);
    const reason = !source
      ? "source_unreadable"
      : row.hashAlgorithm !== "sha256-bytes" || !digest(row.hash)
        ? "unverified_hash"
        : row.hash !== source.sha256
          ? "stale_pointer"
          : row.endLine > source.lines
            ? "range_out_of_bounds"
            : null;
    const expected = c.expected.filter((t) => t.file === file);
    const frozenCurrent = expected.every(
      (t) => t.sourceSha256 === source?.sha256,
    );
    const accepted = reason === null && frozenCurrent;
    if (!verifiedDocumentRank && accepted && expectedFiles.has(file))
      verifiedDocumentRank = documentRank;
    if (
      !sectionRank &&
      accepted &&
      expected.some(
        (t) => row.startLine <= t.endLine && row.endLine >= t.startLine,
      )
    )
      sectionRank = index + 1;
    return {
      file,
      chunkRank: index + 1,
      documentRank,
      startLine: row.startLine,
      endLine: row.endLine,
      score: row.score,
      indexedSha256: digest(row.hash) ? row.hash : null,
      currentSourceSha256: source?.sha256 ?? null,
      hashAlgorithm:
        row.hashAlgorithm === "sha256-bytes" ? "sha256-bytes" : null,
      accepted,
      reason: reason ?? (frozenCurrent ? null : "source_changed"),
    };
  });
  const foundAt10 = new Set(
    pointers
      .filter(
        (p) => p.accepted && p.documentRank <= 10 && expectedFiles.has(p.file),
      )
      .map((p) => p.file),
  );
  return {
    rawDocumentRank,
    verifiedDocumentRank,
    sectionRank,
    documentRecallAt10: foundAt10.size / expectedFiles.size,
    pointers,
    uniqueDocuments: unique.size,
  };
}

async function evaluateCase({ root, prefixes, c, client, repetition }) {
  const sample = {
    id: c.id,
    repetition,
    statusState: "not_attempted",
    queryState: "not_attempted",
    queryIssued: false,
    statusMs: null,
    queryMs: null,
    exclusions: [],
    before: targetChecks(root, c),
  };
  sample.exclusions = [
    ...new Set(sample.before.map((s) => s.reason).filter(Boolean)),
  ];
  if (sample.exclusions.length) return sample;
  let start = performance.now();
  const status = envelope(
    await client.tool("document_search_status", {
      paths: [...new Set(c.expected.map((t) => path.join(root, t.file)))],
    }),
  );
  sample.statusMs = performance.now() - start;
  sample.statusState = status.state;
  if (status.state !== "ready") {
    sample.exclusions.push(`status:${status.state}`);
    return sample;
  }
  sample.generation = status.generation;
  sample.coverage = checkCoverage(root, status, c);
  sample.project = { root: status.project.root, store: status.project.store };
  for (const row of sample.coverage) {
    if (!row.indexed) sample.exclusions.push("target_not_indexed");
    else if (!row.hashCurrent)
      sample.exclusions.push("index_source_hash_mismatch");
  }
  sample.coveragePartial = status.coverage.partial;
  // Active development elsewhere is context, not evidence these frozen targets
  // are stale. Exact coverage/hash and query generation fences decide validity.
  sample.indexState = Object.fromEntries(
    Object.entries(status.indexState ?? {}).filter(
      ([key, value]) =>
        (["indexing", "verifying", "degraded", "catchupRunning"].includes(
          key,
        ) &&
          typeof value === "boolean") ||
        (["pendingFiles", "failedFiles", "overflowCount"].includes(key) &&
          Number.isSafeInteger(value) &&
          value >= 0),
    ),
  );
  if (status.embeddingReady !== true || status.queryState !== "ready") {
    sample.queryState =
      STATES.has(status.queryState) && status.queryState !== "ready"
        ? status.queryState
        : "embedding_unavailable";
    sample.exclusions.push(`query:${sample.queryState}`);
  }
  if (sample.exclusions.length) {
    sample.exclusions = [...new Set(sample.exclusions)];
    return sample;
  }
  start = performance.now();
  sample.queryIssued = true;
  const result = envelope(
    await client.tool("semantic_search", { query: c.query, prefixes }),
  );
  sample.queryMs = performance.now() - start;
  sample.queryState = result.state;
  sample.after = targetChecks(root, c);
  sample.exclusions.push(...sample.after.map((s) => s.reason).filter(Boolean));
  if (result.state !== "ready") sample.exclusions.push(`query:${result.state}`);
  else {
    sample.retrieval = grade(root, prefixes, c, status, result);
    const expected = new Set(c.expected.map((t) => t.file));
    if (
      sample.retrieval.pointers.some((p) => expected.has(p.file) && !p.accepted)
    )
      sample.exclusions.push("expected_pointer_unverified");
  }
  sample.exclusions = [...new Set(sample.exclusions)];
  return sample;
}

function summarize(samples) {
  const valid = samples.filter(
    (s) => s.queryState === "ready" && s.retrieval && s.exclusions.length === 0,
  );
  const average = (f) =>
    valid.length
      ? valid.reduce((sum, s) => sum + f(s.retrieval), 0) / valid.length
      : null;
  const times = valid.map((s) => s.queryMs).sort((a, b) => a - b);
  const counts = {};
  for (const s of samples)
    for (const reason of s.exclusions)
      counts[reason] = (counts[reason] ?? 0) + 1;
  const pointerCounts = {};
  for (const s of samples)
    for (const p of s.retrieval?.pointers ?? []) {
      const reason = p.reason ?? "verified_current";
      pointerCounts[reason] = (pointerCounts[reason] ?? 0) + 1;
    }
  return {
    cases: new Set(samples.map((s) => s.id)).size,
    samples: samples.length,
    queriesIssued: samples.filter((s) => s.queryIssued).length,
    validSamples: valid.length,
    excludedSamples: samples.length - valid.length,
    usableFraction: samples.length ? valid.length / samples.length : null,
    // Document ranks deduplicate chunk hits without promoting past stale/invalid competitors.
    documentMrrAt10: average((r) =>
      r.verifiedDocumentRank > 0 && r.verifiedDocumentRank <= 10
        ? 1 / r.verifiedDocumentRank
        : 0,
    ),
    documentHitAt1: average((r) => Number(r.verifiedDocumentRank === 1)),
    documentRecallAt10: average((r) => r.documentRecallAt10),
    sectionMrrAt10: average((r) =>
      r.sectionRank > 0 && r.sectionRank <= 10 ? 1 / r.sectionRank : 0,
    ),
    sectionHitAt10: average((r) =>
      Number(r.sectionRank > 0 && r.sectionRank <= 10),
    ),
    medianQueryMs: times.length ? times[Math.ceil(times.length / 2) - 1] : null,
    p95QueryMs: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null,
    backgroundIndexingSamples: samples.filter(
      (s) =>
        s.indexState?.indexing ||
        s.indexState?.verifying ||
        s.indexState?.catchupRunning,
    ).length,
    partialCoverageSamples: samples.filter((s) => s.coveragePartial).length,
    degradedIndexSamples: samples.filter((s) => s.indexState?.degraded).length,
    exclusionCounts: counts,
    pointerCounts,
  };
}

class StdioClient {
  constructor(entry, root) {
    this.pending = new Map();
    this.next = 1;
    this.buffer = Buffer.alloc(0);
    this.stderrBytes = 0;
    this.failed = false;
    this.child = spawn(
      process.execPath,
      [entry, "mcp", "--existing-index-only"],
      {
        cwd: root,
        env: { ...process.env, GMAX_SECONDARY_STORE: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stderr.on("data", (b) => {
      this.stderrBytes += b.length;
    });
    this.child.on("error", () => this.fail("transport_error"));
    this.child.on("exit", () => this.fail("transport_closed"));
    this.child.stdin.on("error", () => this.fail("transport_closed"));
    this.child.stdout.on("data", (b) => {
      if (this.failed) return;
      this.buffer = Buffer.concat([this.buffer, b]);
      let nl;
      while ((nl = this.buffer.indexOf(10)) >= 0) {
        if (nl > FRAME_BYTES) {
          this.fail("transport_frame_limit");
          return;
        }
        const line = this.buffer.subarray(0, nl);
        this.buffer = this.buffer.subarray(nl + 1);
        try {
          const message = JSON.parse(line.toString("utf8"));
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error("mcp_error"));
            else pending.resolve(message.result);
          }
        } catch {
          this.fail("transport_invalid_frame");
          return;
        }
      }
      if (this.buffer.length > FRAME_BYTES) this.fail("transport_frame_limit");
    });
  }
  fail(reason) {
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
  call(method, params) {
    if (this.failed) return Promise.reject(new Error("transport_closed"));
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id },
          }) + "\n",
        );
        this.fail("transport_timeout");
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  async initialize() {
    const hello = await this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "gmax-document-evaluation", version: "1" },
    });
    requireValue(
      hello.serverInfo?.name === "gmax-document-search" &&
        hello.protocolVersion === "2025-06-18",
      "unsupported_server",
    );
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    const catalog = await this.call("tools/list", {});
    requireValue(
      JSON.stringify(catalog.tools?.map((t) => t.name).sort()) ===
        JSON.stringify(["document_search_status", "semantic_search"]),
      "unsupported_tools",
    );
    return hello;
  }
  async tool(name, args) {
    const reply = await this.call("tools/call", { name, arguments: args });
    requireValue(
      !reply.isError && reply.structuredContent,
      "invalid_tool_result",
    );
    return reply.structuredContent;
  }
  async close() {
    this.fail("evaluation_complete");
    if (
      !this.child.pid ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGTERM");
      }, 1000);
      const terminal = setTimeout(() => {
        this.child.kill("SIGKILL");
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        clearTimeout(terminal);
        resolve();
      });
      this.child.stdin.end();
    });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixture: { type: "string" },
      sha256: { type: "string" },
      root: { type: "string" },
      entry: { type: "string" },
      output: { type: "string" },
      repeats: { type: "string", default: "1" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/eval-documents.cjs --fixture <frozen-json> --sha256 <digest> --root <existing-project> --entry <installed/dist/bin.js> --output <new-json> [--repeats 1-3]",
    );
    return;
  }
  for (const key of ["fixture", "sha256", "root", "entry", "output"])
    requireValue(values[key], `missing_${key}`);
  const fixture = parseFixture(fs.readFileSync(values.fixture), values.sha256);
  const root = fs.realpathSync(values.root),
    entry = fs.realpathSync(values.entry);
  const repeats = Number(values.repeats);
  requireValue(
    Number.isInteger(repeats) && repeats >= 1 && repeats <= 3,
    "invalid_repeats",
  );
  const prefixes = fixture.prefixes.map((p) => {
    const absolute = path.resolve(root, p);
    requireValue(
      inside(root, absolute) && fs.realpathSync(absolute) === absolute,
      "prefix_out_of_scope",
    );
    return absolute;
  });
  // Reserve artifacts before starting the bridge; refuse any overwrite.
  const output = fs.openSync(values.output, "wx", 0o600);
  let checkpoint, client;
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    fixtureSha256: values.sha256,
    entrySha256: hash(fs.readFileSync(entry)),
    runnerSha256: hash(fs.readFileSync(__filename)),
    root,
    entry,
    repeats,
    plannedSamples: fixture.cases.length * repeats,
    samples: [],
    error: null,
    limits: [
      "Curated single-corpus baseline, not held-out general recall.",
      "Refusals and stale samples are excluded from relevance; usableFraction includes them.",
      "No query text or source bodies in result artifacts; fixture itself contains reviewed queries.",
      "Sequential existing-only calls; no warmup, retry, index/model setup or fallback.",
    ],
  };
  try {
    checkpoint = fs.openSync(`${values.output}.samples.jsonl`, "wx", 0o600);
    client = new StdioClient(entry, root);
    const hello = await client.initialize();
    report.server = {
      name: hello.serverInfo.name,
      protocolVersion: hello.protocolVersion,
    };
    for (let repetition = 1; repetition <= repeats; repetition++) {
      for (const c of fixture.cases) {
        report.interruptedCase = { id: c.id, repetition };
        const sample = await evaluateCase({
          root,
          prefixes,
          c,
          client,
          repetition,
        });
        report.samples.push(sample);
        fs.writeSync(checkpoint, JSON.stringify(sample) + "\n");
        report.interruptedCase = null;
        console.log(
          JSON.stringify({
            id: sample.id,
            repetition,
            status: sample.statusState,
            query: sample.queryState,
            rank: sample.retrieval?.verifiedDocumentRank ?? null,
            exclusions: sample.exclusions,
          }),
        );
      }
    }
  } catch (error) {
    // Never copy transport/native diagnostics, which might contain query text.
    const safe = new Set([
      "unsupported_server",
      "unsupported_tools",
      "invalid_tool_result",
      "invalid_contract",
      "invalid_capabilities",
      "invalid_generation",
      "invalid_project",
      "invalid_coverage",
      "project_changed",
      "generation_changed",
      "invalid_matches",
      "unexpected_pointer_fields",
      "invalid_pointer",
      "transport_error",
      "transport_closed",
      "transport_timeout",
      "transport_frame_limit",
      "transport_invalid_frame",
      "mcp_error",
    ]);
    report.error = safe.has(error.message)
      ? error.message
      : "evaluation_failed";
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
    if (checkpoint !== undefined) fs.closeSync(checkpoint);
    report.finishedAt = new Date().toISOString();
    report.stderrBytes = client?.stderrBytes ?? 0;
    report.summary = summarize(report.samples);
    report.summary.plannedSamples = report.plannedSamples;
    report.summary.notCompletedSamples =
      report.plannedSamples - report.samples.length;
    report.summary.usableFraction =
      report.summary.validSamples / report.plannedSamples;
    report.outcome = report.error
      ? "interrupted"
      : report.summary.validSamples
        ? "quality_measured"
        : "no_usable_samples";
    if (!report.error && !report.summary.validSamples) process.exitCode = 2;
    fs.writeSync(output, JSON.stringify(report, null, 2) + "\n");
    fs.closeSync(output);
    console.log(JSON.stringify({ error: report.error, ...report.summary }));
  }
}

module.exports = {
  parseFixture,
  hash,
  readSource,
  envelope,
  targetChecks,
  checkCoverage,
  grade,
  evaluateCase,
  summarize,
  StdioClient,
};
if (require.main === module)
  main().catch(() => {
    console.error("evaluation_preflight_failed");
    process.exitCode = 1;
  });
