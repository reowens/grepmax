import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const e = require("../scripts/eval-documents.cjs");
const l = require("../scripts/eval-document-lexical.cjs");
const f = require("../scripts/eval-document-fusion.cjs");
let root: string, sources: Map<string, any>, fixture: any, design: any;
const caps = {
  existingIndexOnly: 1,
  queryLogging: false,
  watch: false,
  runtimeStartup: false,
};
const pointer = (file: string, rank = 1, extra = {}) => ({
  file,
  chunkRank: rank,
  startLine: 1,
  endLine: 2,
  score: 0.8,
  sourceSha256: "a".repeat(64),
  ...extra,
});
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "gmax-fusion-")),
  );
  fs.mkdirSync(path.join(root, "docs/services"), { recursive: true });
  sources = new Map(
    ["one", "two"].map((n) => {
      const file = `docs/services/${n}.md`,
        content = `# ${n}\nPRIVATE_BODY_CANARY answer ${n}\n`;
      fs.writeFileSync(path.join(root, file), content);
      return [
        file,
        {
          file,
          content,
          sha256: e.hash(Buffer.from(content)),
          bytes: Buffer.byteLength(content),
          lines: 3,
        },
      ];
    }),
  );
  fixture = {
    schemaVersion: 1,
    purpose: "synthetic",
    prefixes: ["docs"],
    cases: [...sources.values()].map((s, i) => ({
      id: ["redis-secret-config", "people-module-links"][i],
      query: `PRIVATE_QUERY_CANARY answer ${i}`,
      expected: [
        { file: s.file, startLine: 2, endLine: 2, sourceSha256: s.sha256 },
      ],
    })),
  };
  design = {
    createdAt: new Date().toISOString(),
    frozenBeforeNewQuestions: true,
    tuningAfterScoring: false,
    root,
    prefixes: ["docs/services"],
    limits: l.LIMITS,
    parameters: {
      anchorsPerArm: 3,
      armOrder: ["lexical", "dense"],
      rrfConstant: 60,
      outputDocuments: 50,
      lexicalWindowLines: 48,
      lexicalOverlapLines: 8,
      bm25K1: 1.2,
      bm25B: 0.75,
      lexicalChunkCandidates: 50,
    },
    newCohort: { plannedCases: 2, minimumComparableCases: 2 },
    limitations: ["synthetic"],
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("retains lexical-only evidence even when ten overlapping competitors dominate RRF", () => {
  const dense = Array.from({ length: 10 }, (_, i) =>
    pointer(`both-${i}.md`, i + 1),
  );
  const lexical = [
    pointer("lexical-only.md"),
    ...dense.map((p: any, i: number) => ({ ...p, chunkRank: i + 2 })),
  ];
  expect(
    l.fuse(dense, lexical).findIndex((p: any) => p.file === "lexical-only.md"),
  ).toBe(10);
  const protectedRows = f.protectedFusion(dense, lexical);
  expect(protectedRows[0].file).toBe("lexical-only.md");
  expect(protectedRows.slice(0, 4).map((p: any) => p.file)).toEqual([
    "lexical-only.md",
    "both-0.md",
    "both-1.md",
    "both-2.md",
  ]);
});
it("anchors distinct documents, deduplicates, and preserves the selected arm's pointer", () => {
  const dense = [
    pointer("same.md", 1, { startLine: 9, endLine: 10 }),
    pointer("same.md", 2),
    pointer("dense.md", 3),
  ];
  const lexical = [
    pointer("same.md", 1, { startLine: 2 }),
    pointer("lex.md", 2),
  ];
  const result = f.protectedFusion(dense, lexical);
  expect(result.map((p: any) => p.file)).toEqual([
    "same.md",
    "lex.md",
    "dense.md",
  ]);
  expect(result[0].startLine).toBe(2);
  expect(result[0].selection).toBe("lexical_anchor");
  expect(result.map((p: any) => p.chunkRank)).toEqual([1, 2, 3]);
});
it("bounds output without dropping either arm's top three anchors or inventing evidence", () => {
  const dense = Array.from({ length: 50 }, (_, i) =>
    pointer(`d${i}.md`, i + 1),
  );
  const lexical = Array.from({ length: 50 }, (_, i) =>
    pointer(`l${i}.md`, i + 1),
  );
  const result = f.protectedFusion(dense, lexical);
  expect(result).toHaveLength(50);
  expect(new Set(result.map((p: any) => p.file)).size).toBe(50);
  expect(result.slice(0, 6).map((p: any) => p.file)).toEqual([
    "l0.md",
    "d0.md",
    "l1.md",
    "d1.md",
    "l2.md",
    "d2.md",
  ]);
  expect(f.protectedFusion([], [])).toEqual([]);
});
it("reports per-target regressions even when another target keeps the case's first hit", () => {
  const expected = [
    { file: "a.md", startLine: 1, endLine: 1 },
    { file: "b.md", startLine: 1, endLine: 1 },
  ];
  const dense = [pointer("a.md"), pointer("b.md", 2)];
  const protectedRows = [
    pointer("a.md"),
    ...Array.from({ length: 10 }, (_, i) => pointer(`other${i}.md`, i + 2)),
    pointer("b.md", 12),
  ];
  const row = {
    id: "multiple",
    expectedFiles: ["a.md", "b.md"],
    exclusions: [],
    dense: l.grade(dense, expected),
    lexical: l.grade(dense, expected),
    rrf: l.grade(dense, expected),
    protected: l.grade(protectedRows, expected),
  };
  const s = f.summary([row], 1, 1);
  expect(s.denseTop10TargetLosses).toEqual([{ id: "multiple", file: "b.md" }]);
  expect(s.gate).toBe("not_met");
  expect(f.summary([row], 20, 16).gate).toBe("insufficient_evidence");
  expect(f.summary([], 20, 16).metrics.protected.documentRecallAt10).toBeNull();
  expect(f.summary([], 0, 0).gate).toBe("insufficient_evidence");
});
it("rejects any stale competitor, malformed range, or reordered candidate provenance", () => {
  const s = sources.get("docs/services/one.md"),
    p = pointer(s.file, 1, { sourceSha256: s.sha256 });
  expect(f.verifiedPointers([p], sources)).toHaveLength(1);
  for (const extra of [
    { sourceSha256: "0".repeat(64) },
    { endLine: 100 },
    { chunkRank: 2 },
    { score: NaN },
  ])
    expect(() => f.verifiedPointers([{ ...p, ...extra }], sources)).toThrow(
      "candidate_snapshot_mismatch",
    );
});
it("fences exact snapshot bytes and set membership, and rejects mutable algorithm parameters", () => {
  const dir = path.join(root, "snapshot"),
    captured = l.snapshot(root, design.prefixes, dir);
  expect(f.readSnapshot(dir, captured.manifestSha256).sources.size).toBe(2);
  expect(f.snapshotStillCurrent(design, captured)).toBe(true);
  fs.writeFileSync(path.join(root, "docs/services/one.md"), "changed");
  expect(f.snapshotStillCurrent(design, captured)).toBe(false);
  fs.writeFileSync(path.join(dir, "docs/services/one.md"), "changed");
  expect(() => f.readSnapshot(dir, captured.manifestSha256)).toThrow(
    "snapshot_digest_mismatch",
  );
  expect(() =>
    f.validateDesign(
      { ...design, parameters: { ...design.parameters, anchorsPerArm: 4 } },
      fixture,
    ),
  ).toThrow("design_algorithm_mismatch");
  expect(() =>
    f.validateDesign(
      { ...design, limits: { ...l.LIMITS, tokenOccurrences: 1100000 } },
      fixture,
    ),
  ).not.toThrow();
  expect(() =>
    f.validateDesign(
      { ...design, limits: { ...l.LIMITS, tokenOccurrences: 2000000 } },
      fixture,
    ),
  ).toThrow("design_algorithm_mismatch");
  expect(l.lexical(l.buildIndex(sources, 1100000), "answer")).toEqual(
    l.lexical(l.buildIndex(sources), "answer"),
  );
  expect(() => l.buildIndex(sources, 2000000)).toThrow("invalid_token_limit");
});
it("keeps single-pass busy refusals and pacing, without retries or source/query bodies", async () => {
  const calls: string[] = [],
    pauses: number[] = [],
    rows: any[] = [];
  const client = {
    tool: async (name: string, args: any) => {
      calls.push(name);
      if (name === "document_search_status") {
        const s = [...sources.values()].find(
          (s: any) => path.join(root, s.file) === args.paths[0],
        );
        return {
          state: "ready",
          contractVersion: 1,
          capabilities: caps,
          generation: 1,
          project: { root, store: "/fixture/store" },
          embeddingReady: true,
          queryState: "ready",
          coverage: { requested: 1, indexed: 1, partial: false },
          covered: [
            {
              path: args.paths[0],
              hash: s.sha256,
              hashAlgorithm: "sha256-bytes",
            },
          ],
        };
      }
      return { state: "busy", contractVersion: 1, capabilities: caps };
    },
  };
  await f.collect({
    fixture,
    design,
    sources,
    index: l.buildIndex(sources),
    client,
    onRow: (r: any) => rows.push(r),
    pause: async (ms: number) => {
      pauses.push(ms);
    },
  });
  expect(calls).toEqual([
    "document_search_status",
    "semantic_search",
    "document_search_status",
    "semantic_search",
  ]);
  expect(pauses).toEqual([1000]);
  expect(rows.map((r) => r.exclusions)).toEqual([
    ["query:busy"],
    ["query:busy"],
  ]);
  expect(f.summary(rows, 2, 2).gate).toBe("insufficient_evidence");
  expect(JSON.stringify(rows)).not.toContain("PRIVATE_QUERY_CANARY");
});
it("does not request live resources when the frozen target is absent from the snapshot", async () => {
  const rows: any[] = [];
  await f.collect({
    fixture: { cases: [fixture.cases[0]] },
    design,
    sources: new Map(),
    index: {},
    client: {
      tool: () => {
        throw new Error("must_not_call");
      },
    },
    onRow: (r: any) => rows.push(r),
  });
  expect(rows[0].exclusions).toEqual(["frozen_target_snapshot_mismatch"]);
});

function args(mode: string, extra: string[]) {
  const fixtureFile = path.join(root, "fixture.json"),
    designFile = path.join(root, "design.json");
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
  fs.writeFileSync(designFile, JSON.stringify(design));
  return [
    path.resolve("scripts/eval-document-fusion.cjs"),
    "--mode",
    mode,
    "--fixture",
    fixtureFile,
    "--fixture-sha256",
    e.hash(fs.readFileSync(fixtureFile)),
    "--design",
    designFile,
    "--design-sha256",
    e.hash(fs.readFileSync(designFile)),
    "--output",
    path.join(root, "report.json"),
    ...extra,
  ];
}
it("replays an exact private archive without rescoring lexical queries, and refuses overwrite", () => {
  const dir = path.join(root, "snapshot"),
    captured = l.snapshot(root, design.prefixes, dir);
  const input = {
    fixtureSha256: e.hash(Buffer.from(JSON.stringify(fixture))),
    snapshot: { manifestSha256: captured.manifestSha256 },
    cases: fixture.cases.map((c: any) => {
      const s = sources.get(c.expected[0].file),
        p = pointer(s.file, 1, { sourceSha256: s.sha256 });
      return {
        id: c.id,
        exclusions: [],
        archivedDense: { pointers: [p] },
        lexical: { pointers: [p] },
      };
    }),
  };
  const inputFile = path.join(root, "input.json");
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const argv = args("replay", [
    "--input",
    inputFile,
    "--input-sha256",
    e.hash(fs.readFileSync(inputFile)),
    "--snapshot",
    dir,
  ]);
  const run = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(run.status, run.stderr).toBe(0);
  const bytes = fs.readFileSync(path.join(root, "report.json"), "utf8"),
    r = JSON.parse(bytes);
  expect(r.summary.gate).toBe("pass");
  expect(r.summary.comparableCases).toBe(2);
  expect(bytes + run.stdout + run.stderr).not.toContain("PRIVATE_QUERY_CANARY");
  expect(bytes).not.toContain("PRIVATE_BODY_CANARY");
  expect(fs.statSync(path.join(root, "report.json")).mode & 0o777).toBe(0o600);
  expect(
    spawnSync(process.execPath, argv, { encoding: "utf8", timeout: 5000 })
      .status,
  ).toBe(1);
});
it("uses actual existing-only stdio, checkpoints interrupted work and never accepts an incomplete cohort", () => {
  const entry = path.join(root, "bridge.cjs");
  fs.writeFileSync(
    entry,
    `const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),rl=require('node:readline');
    if(JSON.stringify(process.argv.slice(2))!=='["mcp","--existing-index-only"]')process.exit(2);
    const root=${JSON.stringify(root)},caps=${JSON.stringify(caps)},base={contractVersion:1,capabilities:caps,state:'ready',generation:1};let statuses=0;
    rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result;
      if(m.method==='initialize')result={protocolVersion:'2025-06-18',serverInfo:{name:'gmax-document-search'}};
      else if(m.method==='tools/list')result={tools:[{name:'document_search_status'},{name:'semantic_search'}]};
      else if(m.params.name==='document_search_status'){if(++statuses===2)process.exit(0);result={structuredContent:{...base,project:{root,store:'/fixture/store'},embeddingReady:true,queryState:'ready',coverage:{requested:1,indexed:1,partial:false},covered:m.params.arguments.paths.map(p=>({path:p,hash:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),hashAlgorithm:'sha256-bytes'}))}};}
      else{const p=path.join(root,'docs/services/one.md');result={structuredContent:{...base,root,store:'/fixture/store',matches:[{path:p,startLine:2,endLine:2,score:.8,hash:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),hashAlgorithm:'sha256-bytes'}]}};}
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
  );
  const argv = args("live", [
    "--entry",
    entry,
    "--entry-sha256",
    e.hash(fs.readFileSync(entry)),
    "--snapshot",
    path.join(root, "live-snapshot"),
  ]);
  const run = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(run.status, run.stderr).toBe(1);
  const bytes = fs.readFileSync(path.join(root, "report.json"), "utf8"),
    r = JSON.parse(bytes);
  expect(r.error).toBe("fusion_qualification_failed");
  expect(r.summary.gate).toBe("interrupted");
  expect(r.summary.completedCases).toBe(1);
  expect(r.rows).toHaveLength(1);
  expect(
    fs
      .readFileSync(path.join(root, "report.json.samples.jsonl"), "utf8")
      .trim()
      .split("\n"),
  ).toHaveLength(1);
  expect(bytes + run.stdout + run.stderr).not.toContain("PRIVATE_QUERY_CANARY");
  expect(bytes).not.toContain("PRIVATE_BODY_CANARY");
});
