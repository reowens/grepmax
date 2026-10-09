import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const e = require("../scripts/eval-documents.cjs");
const l = require("../scripts/eval-document-lexical.cjs");
let root: string;
let sources: Map<string, any>;
const source = (file: string, content: string) => ({
  file,
  content,
  sha256: e.hash(Buffer.from(content)),
  bytes: Buffer.byteLength(content),
  lines: content.split("\n").length,
});
const pointer = (s: any, rank = 1) => ({
  file: s.file,
  chunkRank: rank,
  startLine: 1,
  endLine: s.lines,
  accepted: true,
  indexedSha256: s.sha256,
  currentSourceSha256: s.sha256,
  hashAlgorithm: "sha256-bytes",
  score: 0.8,
});
const archived = (id: string, pointers: any[], extra = {}) => ({
  id,
  arm: "narrow",
  queryState: "ready",
  generation: 1,
  project: { root, store: "/synthetic-store" },
  exclusions: [],
  retrieval: { pointers },
  ...extra,
});
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "gmax-lexical-")),
  );
  fs.mkdirSync(path.join(root, "docs/services"), { recursive: true });
  sources = new Map([
    [
      "docs/services/a.md",
      source(
        "docs/services/a.md",
        "PRIVATE_BODY_CANARY\nRedis password process arguments configuration",
      ),
    ],
    [
      "docs/services/b.md",
      source("docs/services/b.md", "unrelated weather forecast"),
    ],
  ]);
  for (const s of sources.values())
    fs.writeFileSync(path.join(root, s.file), s.content);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it("scores lexical evidence without expected targets and never pads zero-score candidates", () => {
  const index = l.buildIndex(sources);
  expect(l.lexical(index, "Redis password process arguments")[0].file).toBe(
    "docs/services/a.md",
  );
  expect(l.lexical(index, "completelyabsent")).toEqual([]);
  expect(l.lexical(index, "the and why")).toEqual([]);
  expect(l.tokens("QRC REST-api Identity")).toEqual([
    "qrc",
    "rest",
    "api",
    "identity",
  ]);
});
it("uses stable path/line ties, bounded overlapping windows, and hard token/file limits", () => {
  const tie = new Map([
    ["b.md", source("b.md", "equal")],
    ["a.md", source("a.md", "equal")],
  ]);
  expect(l.lexical(l.buildIndex(tie), "equal").map((p: any) => p.file)).toEqual(
    ["a.md", "b.md"],
  );
  const windows = l.buildIndex(
    new Map([["a.md", source("a.md", Array(100).fill("equal").join("\n"))]]),
  ).chunks;
  expect(windows.map((p: any) => [p.startLine, p.endLine])).toEqual([
    [1, 48],
    [41, 88],
    [81, 100],
  ]);
  expect(() =>
    l.buildIndex(new Map([["a.md", source("a.md", "token ".repeat(1000001))]])),
  ).toThrow("token_limit");
  fs.writeFileSync(
    path.join(root, "docs/services/large.md"),
    Buffer.alloc(l.LIMITS.fileBytes + 1),
  );
  expect(() =>
    l.snapshot(root, ["docs/services"], path.join(root, "large-snapshot")),
  ).toThrow("read_limit");
});
it("captures exact private bytes/manifest and rejects alias or overwrite", () => {
  const dest = path.join(root, "snapshot");
  const captured = l.snapshot(root, ["docs/services"], dest);
  expect(captured.sources.size).toBe(2);
  expect(captured.manifest.files.every((f: any) => !("content" in f))).toBe(
    true,
  );
  expect(fs.statSync(dest).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(dest, "docs/services/a.md")).mode & 0o777).toBe(
    0o600,
  );
  expect(() => l.snapshot(root, ["docs/services"], dest)).toThrow();
  fs.symlinkSync(
    path.join(root, "docs/services/a.md"),
    path.join(root, "docs/services/alias.md"),
  );
  expect(() =>
    l.snapshot(root, ["docs/services"], path.join(root, "alias-snapshot")),
  ).toThrow("source_alias");
});
it("excludes the entire archive case when any competitor pointer is stale or out of range", () => {
  const a = sources.get("docs/services/a.md"),
    b = sources.get("docs/services/b.md");
  const sample = archived("test", [
    pointer(a),
    { ...pointer(b, 2), indexedSha256: "0".repeat(64) },
  ]);
  expect(
    l.archivedCase({ root, samples: [sample] }, { id: "test" }, sources)
      .exclusions,
  ).toEqual(["archive_pointer_snapshot_mismatch"]);
  sample.retrieval.pointers[1] = { ...pointer(b, 2), endLine: 100 };
  expect(
    l.archivedCase({ root, samples: [sample] }, { id: "test" }, sources)
      .exclusions,
  ).toEqual(["archive_pointer_snapshot_mismatch"]);
  sample.retrieval.pointers[1] = pointer(b, 2);
  expect(
    l.archivedCase({ root, samples: [sample] }, { id: "test" }, sources)
      .exclusions,
  ).toEqual([]);
  expect(
    l.archivedCase({ root, samples: [sample, sample] }, { id: "test" }, sources)
      .exclusions,
  ).toEqual(["archive_missing_or_duplicate"]);
});
it("requires original archive resource identity and a valid exclusion array", () => {
  const a = sources.get("docs/services/a.md");
  for (const extra of [
    { generation: 0 },
    { project: { root: "/other", store: "/store" } },
    { project: { root, store: "relative" } },
    { exclusions: undefined },
  ]) {
    expect(
      l.archivedCase(
        { root, samples: [archived("test", [pointer(a)], extra)] },
        { id: "test" },
        sources,
      ).exclusions,
    ).toEqual(["archive_invalid_identity"]);
  }
});
it("retains refused cases separately and excludes changed frozen targets", () => {
  const a = sources.get("docs/services/a.md");
  const c = {
    id: "test",
    query: "Redis",
    expected: [
      { file: a.file, sourceSha256: a.sha256, startLine: 2, endLine: 2 },
    ],
  };
  const archive = {
    root,
    samples: [
      archived("test", [], { queryState: "busy", exclusions: ["query:busy"] }),
    ],
  };
  const result = l.evaluate(
    { cases: [c] },
    archive,
    sources,
    l.buildIndex(sources),
  );
  expect(result.summary.lexicalAll.cases).toBe(1);
  expect(result.summary.sharedCases).toBe(0);
  expect(result.cases[0].exclusions).toEqual(["archive:query:busy"]);
  c.expected[0].sourceSha256 = "0".repeat(64);
  expect(
    l.evaluate({ cases: [c] }, archive, sources, l.buildIndex(sources)).cases[0]
      .lexical,
  ).toBeNull();
});
it("fuses distinct document ranks with fixed RRF and keeps representative provenance", () => {
  const dense = [
    { file: "a.md", chunkRank: 1 },
    { file: "a.md", chunkRank: 2 },
    { file: "b.md", chunkRank: 3 },
  ];
  const lex = [
    { file: "b.md", chunkRank: 1 },
    { file: "c.md", chunkRank: 2 },
  ];
  const result = l.fuse(dense, lex);
  expect(result.map((p: any) => p.file)).toEqual(["b.md", "a.md", "c.md"]);
  expect(result[0].score).toBeCloseTo(1 / 62 + 1 / 61);
  expect(result[0].representativeArm).toBe("lexical");
  expect(result[0].denseDocumentRank).toBe(2);
  expect(result[0].lexicalDocumentRank).toBe(1);
});
it("runs actual CLI offline with private reports, exact archive/plan hash, and overwrite refusal", () => {
  const a = sources.get("docs/services/a.md");
  const fixture = {
    schemaVersion: 1,
    purpose: "synthetic",
    prefixes: ["docs"],
    cases: [
      {
        id: "redis-secret-config",
        query: "PRIVATE_QUERY_CANARY Redis",
        expected: [
          { file: a.file, sourceSha256: a.sha256, startLine: 2, endLine: 2 },
        ],
      },
    ],
  };
  const archive = {
    root,
    fixtureSha256: e.hash(Buffer.from(JSON.stringify(fixture))),
    prefixes: { narrow: [path.join(root, "docs/services")] },
    samples: [archived("redis-secret-config", [pointer(a)])],
  };
  const archiveBytes = Buffer.from(JSON.stringify(archive));
  const plan = {
    root,
    prefixes: ["docs/services"],
    fixtureSha256: archive.fixtureSha256,
    archiveSha256: e.hash(archiveBytes),
    limits: l.LIMITS,
    createdBeforeScoring: true,
    createdAt: new Date().toISOString(),
    queryChanges: false,
    targetChanges: false,
    tuningAfterScoring: false,
    lexical: {
      chunkLines: 48,
      overlapLines: 8,
      bm25K1: 1.2,
      bm25B: 0.75,
      candidateChunks: 50,
    },
    fusion: { constant: 60, armWeights: [1, 1] },
    confounds: ["synthetic archive replay"],
  };
  fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify(fixture));
  fs.writeFileSync(path.join(root, "archive.json"), archiveBytes);
  const planBytes = Buffer.from(JSON.stringify(plan));
  fs.writeFileSync(path.join(root, "plan.json"), planBytes);
  const args = [
    path.resolve("scripts/eval-document-lexical.cjs"),
    "--fixture",
    path.join(root, "fixture.json"),
    "--plan",
    path.join(root, "plan.json"),
    "--plan-sha256",
    e.hash(planBytes),
    "--archive",
    path.join(root, "archive.json"),
    "--snapshot",
    path.join(root, "snapshot"),
    "--output",
    path.join(root, "report.json"),
  ];
  const run = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 10000,
  });
  expect(run.status, run.stderr).toBe(0);
  const reportBytes = fs.readFileSync(path.join(root, "report.json"), "utf8");
  expect(reportBytes).not.toContain("PRIVATE_QUERY_CANARY");
  expect(reportBytes).not.toContain("PRIVATE_BODY_CANARY");
  expect(JSON.parse(reportBytes).summary.sharedCases).toBe(1);
  expect(fs.statSync(path.join(root, "report.json")).mode & 0o777).toBe(0o600);
  expect(
    spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 })
      .status,
  ).toBe(1);
  fs.writeFileSync(path.join(root, a.file), "changed source");
  const excludedArgs = args.map((arg) =>
    arg === path.join(root, "snapshot")
      ? path.join(root, "excluded-snapshot")
      : arg === path.join(root, "report.json")
        ? path.join(root, "excluded-report.json")
        : arg,
  );
  expect(
    spawnSync(process.execPath, excludedArgs, {
      encoding: "utf8",
      timeout: 10000,
    }).status,
  ).toBe(2);
  const excluded = JSON.parse(
    fs.readFileSync(path.join(root, "excluded-report.json"), "utf8"),
  );
  expect(excluded.outcome).toBe("no_usable_lexical_cases");
  expect(excluded.summary.lexicalAll.cases).toBe(0);
  const changed = { ...plan, lexical: { ...plan.lexical, bm25B: 0.9 } };
  expect(() => l.validatePlan(changed, fixture, archiveBytes)).toThrow(
    "plan_algorithm_mismatch",
  );
  expect(() =>
    l.validatePlan({ ...plan, prefixes: ["."] }, fixture, archiveBytes),
  ).toThrow("scope_broadened");
});
