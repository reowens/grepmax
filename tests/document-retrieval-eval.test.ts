import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

// Evaluator is a repo-only built-in Node script, never a runtime/native import.
const e = require("../scripts/eval-documents.cjs");
let root: string;
let target: any;
let c: any;
let status: any;
const capabilities = {
  existingIndexOnly: 1,
  queryLogging: false,
  watch: false,
  runtimeStartup: false,
};
const envelope = (state = "ready") => ({
  state,
  contractVersion: 1,
  capabilities,
  generation: 7,
});
const row = (file = "docs/target.md", extra = {}) => ({
  path: path.join(root, file),
  startLine: 1,
  endLine: 2,
  score: 0.8,
  hash: e.readSource(root, file).sha256,
  hashAlgorithm: "sha256-bytes",
  ...extra,
});
const result = (matches: any[]) => ({
  ...envelope(),
  root,
  store: "/fixture/store",
  matches,
});
const fixture = () => ({
  schemaVersion: 1,
  purpose: "synthetic evaluation regression",
  prefixes: ["docs"],
  cases: [c],
});

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "gmax-doc-eval-")),
  );
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(
    path.join(root, "docs/target.md"),
    "# Heading\nfirst\nsecond\n",
  );
  fs.writeFileSync(path.join(root, "docs/other.md"), "# Other\nbody\n");
  target = {
    file: "docs/target.md",
    sourceSha256: e.readSource(root, "docs/target.md").sha256,
    startLine: 2,
    endLine: 3,
  };
  c = {
    id: "synthetic-case",
    query: "PRIVATE_QUERY_CANARY",
    expected: [target],
  };
  status = {
    ...envelope(),
    project: { root, store: "/fixture/store" },
    embeddingReady: true,
    queryState: "ready",
    coverage: { requested: 1, indexed: 1, partial: false },
    covered: [
      {
        path: path.join(root, target.file),
        hash: target.sourceSha256,
        hashAlgorithm: "sha256-bytes",
      },
    ],
    indexState: { indexing: false, degraded: false },
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("requires a frozen fixture checksum and contained target ranges", () => {
  const bytes = Buffer.from(JSON.stringify(fixture()));
  expect(e.parseFixture(bytes, e.hash(bytes)).cases).toHaveLength(1);
  expect(() => e.parseFixture(bytes, "0".repeat(64))).toThrow("checksum");
  target.file = "../escape.md";
  const invalid = Buffer.from(JSON.stringify(fixture()));
  expect(() => e.parseFixture(invalid, e.hash(invalid))).toThrow(
    "invalid_target",
  );
});
it("rejects duplicate case IDs and targets outside explicit prefixes", () => {
  const f = fixture();
  f.cases.push(c);
  let bytes = Buffer.from(JSON.stringify(f));
  expect(() => e.parseFixture(bytes, e.hash(bytes))).toThrow("duplicate");
  f.cases.pop();
  f.prefixes = ["elsewhere"];
  bytes = Buffer.from(JSON.stringify(f));
  expect(() => e.parseFixture(bytes, e.hash(bytes))).toThrow("out_of_scope");
});
it("separates document rank from chunk/section rank and deduplicates documents", () => {
  const g = e.grade(
    root,
    [path.join(root, "docs")],
    c,
    status,
    result([row("docs/other.md"), row("docs/other.md"), row()]),
  );
  expect(g.rawDocumentRank).toBe(2);
  expect(g.verifiedDocumentRank).toBe(2);
  expect(g.sectionRank).toBe(3);
  expect(g.uniqueDocuments).toBe(2);
  expect(g.documentRecallAt10).toBe(1);
});
it("does not treat finding the correct document as finding the expected section", () => {
  target.startLine = 3;
  const g = e.grade(
    root,
    [root],
    c,
    status,
    result([row(undefined, { startLine: 1, endLine: 1 })]),
  );
  expect(g.verifiedDocumentRank).toBe(1);
  expect(g.sectionRank).toBe(0);
});
it("uses the rank cutoff for MRR and the fraction of expected documents for recall", () => {
  const summaries = e.summarize([
    {
      id: "a",
      queryIssued: true,
      queryState: "ready",
      queryMs: 10,
      exclusions: [],
      retrieval: {
        verifiedDocumentRank: 11,
        sectionRank: 11,
        documentRecallAt10: 0,
        pointers: [],
      },
    },
    {
      id: "b",
      queryIssued: true,
      queryState: "ready",
      queryMs: 20,
      exclusions: [],
      retrieval: {
        verifiedDocumentRank: 2,
        sectionRank: 2,
        documentRecallAt10: 0.5,
        pointers: [],
      },
    },
  ]);
  expect(summaries.documentMrrAt10).toBe(0.25);
  expect(summaries.sectionMrrAt10).toBe(0.25);
  expect(summaries.documentRecallAt10).toBe(0.25);
});
it("grades recall over all expected documents rather than any one matching hit", () => {
  c.expected.push({
    ...target,
    file: "docs/other.md",
    sourceSha256: e.readSource(root, "docs/other.md").sha256,
  });
  const g = e.grade(root, [root], c, status, result([row()]));
  expect(g.documentRecallAt10).toBe(0.5);
});
it("rejects stale digest/ranges and never blesses them with a freshly computed hash", () => {
  const pointer = row();
  fs.writeFileSync(path.join(root, target.file), "# Changed\n");
  const g = e.grade(root, [root], c, status, result([pointer]));
  expect(g.rawDocumentRank).toBe(1);
  expect(g.verifiedDocumentRank).toBe(0);
  expect(g.pointers[0].reason).toBe("stale_pointer");
});
it.each([
  [{ hash: undefined, hashAlgorithm: undefined }, "unverified_hash"],
  [{ endLine: 100 }, "range_out_of_bounds"],
])("rejects unsafe section pointers %s", (extra, reason) => {
  const g = e.grade(root, [root], c, status, result([row(undefined, extra)]));
  expect(g.pointers[0].accepted).toBe(false);
  expect(g.pointers[0].reason).toBe(reason);
});
it("fences generations and never accepts source bodies or unscoped pointers", () => {
  expect(() =>
    e.grade(root, [root], c, status, { ...result([row()]), generation: 8 }),
  ).toThrow("generation_changed");
  expect(() =>
    e.grade(
      root,
      [root],
      c,
      status,
      result([row(undefined, { text: "SOURCE_BODY_CANARY" })]),
    ),
  ).toThrow("unexpected_pointer_fields");
  expect(() =>
    e.grade(root, [path.join(root, "elsewhere")], c, status, result([row()])),
  ).toThrow("invalid_pointer");
});
it("refuses symlink aliases, directories and oversized source files", () => {
  fs.symlinkSync(
    path.join(root, target.file),
    path.join(root, "docs/alias.md"),
  );
  expect(() => e.readSource(root, "docs/alias.md")).toThrow(
    "source_out_of_scope",
  );
  fs.mkdirSync(path.join(root, "docs/dir.md"));
  expect(() => e.readSource(root, "docs/dir.md")).toThrow();
  fs.writeFileSync(
    path.join(root, "docs/large.md"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  );
  expect(() => e.readSource(root, "docs/large.md")).toThrow(
    "source_unreadable",
  );
});
it("checks coverage identities and indexed provenance before querying", async () => {
  const calls: string[] = [];
  status.covered[0].hash = "0".repeat(64);
  const client = {
    tool: async (name: string) => {
      calls.push(name);
      return status;
    },
  };
  const sample = await e.evaluateCase({
    root,
    prefixes: [root],
    c,
    client,
    repetition: 1,
  });
  expect(calls).toEqual(["document_search_status"]);
  expect(sample.exclusions).toContain("index_source_hash_mismatch");
  expect(sample.queryIssued).toBe(false);
  status.covered[0].path = path.join(root, "docs/other.md");
  expect(() => e.checkCoverage(root, status, c)).toThrow("invalid_coverage");
});
it("reports refusals separately from relevance misses and does not retry/warm up", async () => {
  let calls = 0;
  const client = {
    tool: async () => (++calls === 1 ? status : envelope("host_pressure")),
  };
  const sample = await e.evaluateCase({
    root,
    prefixes: [root],
    c,
    client,
    repetition: 1,
  });
  const summary = e.summarize([sample]);
  expect(calls).toBe(2);
  expect(sample.queryState).toBe("host_pressure");
  expect(summary.validSamples).toBe(0);
  expect(summary.documentMrrAt10).toBeNull();
  expect(summary.usableFraction).toBe(0);
});
it("a ready empty result is a measurable miss, not a refusal", async () => {
  const client = {
    tool: async (name: string) =>
      name === "document_search_status" ? status : result([]),
  };
  const sample = await e.evaluateCase({
    root,
    prefixes: [root],
    c,
    client,
    repetition: 1,
  });
  expect(e.summarize([sample]).documentMrrAt10).toBe(0);
  expect(e.summarize([sample]).validSamples).toBe(1);
});
it("excludes an expected source that changes during retrieval", async () => {
  const pointer = row();
  const client = {
    tool: async (name: string) => {
      if (name === "document_search_status") return status;
      fs.writeFileSync(path.join(root, target.file), "CHANGED\n");
      return result([pointer]);
    },
  };
  const sample = await e.evaluateCase({
    root,
    prefixes: [root],
    c,
    client,
    repetition: 1,
  });
  expect(sample.exclusions).toContain("source_changed");
  expect(sample.exclusions).toContain("expected_pointer_unverified");
  expect(e.summarize([sample]).validSamples).toBe(0);
  expect(JSON.stringify(sample)).not.toContain("PRIVATE_QUERY_CANARY");
  expect(JSON.stringify(sample)).not.toContain("CHANGED");
});
it.each(["degraded", "indexing", "verifying", "catchupRunning"])(
  "records global index state %s without rejecting fresh covered targets",
  async (key) => {
    status.indexState[key] = true;
    let calls = 0;
    const client = {
      tool: async (name: string) => {
        calls++;
        return name === "document_search_status" ? status : result([row()]);
      },
    };
    const sample = await e.evaluateCase({
      root,
      prefixes: [root],
      c,
      client,
      repetition: 1,
    });
    expect(calls).toBe(2);
    expect(sample.exclusions).toEqual([]);
    expect(sample.indexState[key]).toBe(true);
    expect(e.summarize([sample]).validSamples).toBe(1);
  },
);
it("counts missing coverage and source changes separately", async () => {
  status.covered = [];
  status.coverage.indexed = 0;
  const client = { tool: async () => status };
  const sample = await e.evaluateCase({
    root,
    prefixes: [root],
    c,
    client,
    repetition: 1,
  });
  expect(sample.exclusions).toContain("target_not_indexed");
  fs.writeFileSync(path.join(root, target.file), "NEW\n");
  const changed = await e.evaluateCase({
    root,
    prefixes: [root],
    c,
    client,
    repetition: 1,
  });
  expect(changed.statusState).toBe("not_attempted");
  expect(changed.exclusions).toContain("source_changed");
});
it("uses the real stdio handshake and exactly the existing-only entry arguments", async () => {
  const entry = path.join(root, "bridge.cjs");
  fs.writeFileSync(
    entry,
    `
    const readline = require('node:readline');
    if (JSON.stringify(process.argv.slice(2)) !== '["mcp","--existing-index-only"]') process.exit(2);
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line); if (!m.id) return;
      const result=m.method==='initialize' ? {protocolVersion:'2025-06-18',serverInfo:{name:'gmax-document-search',version:'1'}} :
        m.method==='tools/list' ? {tools:[{name:'semantic_search'},{name:'document_search_status'}]} : {structuredContent:${JSON.stringify(status)}};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });
  `,
  );
  const client = new e.StdioClient(entry, root);
  try {
    expect((await client.initialize()).serverInfo.name).toBe(
      "gmax-document-search",
    );
    expect(
      (await client.tool("document_search_status", { paths: [] })).generation,
    ).toBe(7);
  } finally {
    await client.close();
  }
}, 5000);

it("the CLI writes private checkpointed evidence without queries or bodies and refuses overwrite", () => {
  const entry = path.join(root, "cli-bridge.cjs");
  const payload = JSON.stringify(result([row()]));
  fs.writeFileSync(
    entry,
    `
    const readline=require('node:readline');
    if(JSON.stringify(process.argv.slice(2))!=='["mcp","--existing-index-only"]')process.exit(2);
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);if(!m.id)return;
      const result=m.method==='initialize'?{protocolVersion:'2025-06-18',serverInfo:{name:'gmax-document-search',version:'1'},instructions:'SOURCE_BODY_CANARY'}:
        m.method==='tools/list'?{tools:[{name:'document_search_status'},{name:'semantic_search'}]}:
        {structuredContent:m.params.name==='document_search_status'?${JSON.stringify(status)}:${payload}};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });
  `,
  );
  const fixturePath = path.join(root, "fixture.json");
  const bytes = Buffer.from(JSON.stringify(fixture()));
  fs.writeFileSync(fixturePath, bytes);
  const output = path.join(root, "report.json");
  const args = [
    path.resolve("scripts/eval-documents.cjs"),
    "--fixture",
    fixturePath,
    "--sha256",
    e.hash(bytes),
    "--root",
    root,
    "--entry",
    entry,
    "--output",
    output,
  ];
  const run = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(run.status).toBe(0);
  const artifact = fs.readFileSync(output, "utf8");
  const report = JSON.parse(artifact);
  expect(report.summary.validSamples).toBe(1);
  expect(report.summary.documentMrrAt10).toBe(1);
  expect(report.summary.notCompletedSamples).toBe(0);
  expect(report.runnerSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(artifact + run.stdout + run.stderr).not.toContain(
    "PRIVATE_QUERY_CANARY",
  );
  expect(artifact + run.stdout + run.stderr).not.toContain(
    "SOURCE_BODY_CANARY",
  );
  expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  expect(
    fs.readFileSync(`${output}.samples.jsonl`, "utf8").trim().split("\n"),
  ).toHaveLength(1);
  expect(spawnSync(process.execPath, args, { timeout: 5000 }).status).toBe(1);
  expect(fs.readFileSync(output, "utf8")).toBe(artifact);
  fs.writeFileSync(
    entry,
    fs
      .readFileSync(entry, "utf8")
      .replace(payload, JSON.stringify(envelope("host_pressure"))),
  );
  const refusedOutput = path.join(root, "refused.json");
  const refused = spawnSync(
    process.execPath,
    [...args.slice(0, -1), refusedOutput],
    { timeout: 5000 },
  );
  expect(refused.status).toBe(2);
  const unavailable = JSON.parse(fs.readFileSync(refusedOutput, "utf8"));
  expect(unavailable.outcome).toBe("no_usable_samples");
  expect(unavailable.summary.documentMrrAt10).toBeNull();
  expect(unavailable.summary.exclusionCounts).toEqual({
    "query:host_pressure": 1,
  });
});

it("bounds transport buffering after a frame-limit violation", async () => {
  const entry = path.join(root, "oversized.cjs");
  fs.writeFileSync(
    entry,
    `process.stdin.once('data',()=>process.stdout.write('x'.repeat(1024*1024+100)));`,
  );
  const client = new e.StdioClient(entry, root);
  try {
    await expect(client.initialize()).rejects.toThrow("transport_frame_limit");
    expect(client.buffer.length).toBe(0);
    await expect(client.tool("semantic_search", {})).rejects.toThrow(
      "transport_closed",
    );
  } finally {
    await client.close();
  }
}, 5000);

it("closes promptly when bridge spawning failed before a child PID exists", async () => {
  const client = new e.StdioClient(
    path.join(root, "unused.cjs"),
    path.join(root, "missing-directory"),
  );
  await expect(client.initialize()).rejects.toThrow("transport_error");
  expect(client.child.pid).toBeUndefined();
  await client.close();
}, 1000);
