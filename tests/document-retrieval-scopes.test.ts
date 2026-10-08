import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const e = require("../scripts/eval-documents.cjs");
const p = require("../scripts/eval-document-scopes.cjs");
let root: string;
let fixture: any;
const caps = {
  existingIndexOnly: 1,
  queryLogging: false,
  watch: false,
  runtimeStartup: false,
};
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "gmax-scope-eval-")),
  );
  fs.mkdirSync(path.join(root, "docs/services"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs/modules"));
  const cases = ["docs/services/one.md", "docs/modules/two.md"].map(
    (file, i) => {
      fs.writeFileSync(path.join(root, file), "# Synthetic source\nanswer\n");
      return {
        id: `case-${i}`,
        query: "PRIVATE_QUERY_CANARY",
        expected: [
          {
            file,
            startLine: 2,
            endLine: 2,
            sourceSha256: e.readSource(root, file).sha256,
          },
        ],
      };
    },
  );
  fixture = {
    schemaVersion: 1,
    purpose: "synthetic scope comparison",
    prefixes: ["docs"],
    cases,
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const sample = (id: string, arm: string, rank: number, extra = {}) => ({
  id,
  arm,
  generation: 1,
  project: { root: "/fixture", store: "/store" },
  queryState: "ready",
  queryIssued: true,
  queryMs: 10,
  exclusions: [],
  retrieval: {
    verifiedDocumentRank: rank,
    sectionRank: rank,
    documentRecallAt10: Number(rank > 0 && rank <= 10),
    pointers: [],
  },
  ...extra,
});

it("compares the same usable cohort instead of averaging differently refused arms", () => {
  const s = p.pairSummary(
    [
      sample("a", "broad", 10),
      sample("a", "narrow", 1),
      sample("b", "broad", 1),
      sample("b", "narrow", 0, {
        queryState: "busy",
        exclusions: ["query:busy"],
      }),
    ],
    2,
  );
  expect(s.comparablePairs).toBe(1);
  expect(s.shared.broad.documentMrrAt10).toBe(0.1);
  expect(s.shared.narrow.documentMrrAt10).toBe(1);
  expect(s.standalone.broad.validSamples).toBe(2);
  expect(s.pairs[1].reasons).toEqual(["narrow_unusable"]);
});
it("fences changes of generation and store across otherwise usable arms", () => {
  const s = p.pairSummary(
    [
      sample("a", "broad", 1),
      sample("a", "narrow", 1, { generation: 2 }),
      sample("b", "broad", 1),
      sample("b", "narrow", 1, {
        project: { root: "/fixture", store: "/other" },
      }),
    ],
    2,
  );
  expect(s.comparablePairs).toBe(0);
  expect(s.shared.broad.documentMrrAt10).toBeNull();
  expect(s.pairs[0].reasons).toContain("generation_changed_between_arms");
  expect(s.pairs[1].reasons).toContain("project_changed_between_arms");
});
it("rejects duplicate arms and accounts for incomplete pairs", () => {
  expect(() =>
    p.pairSummary([sample("a", "broad", 1), sample("a", "broad", 2)], 1),
  ).toThrow("duplicate_arm");
  const s = p.pairSummary([sample("a", "broad", 1)], 2);
  expect(s.completedPairs).toBe(0);
  expect(s.comparablePairs).toBe(0);
});

it("does not compare samples missing resource generation or project provenance", () => {
  const s = p.pairSummary(
    [
      sample("a", "broad", 1, { generation: undefined }),
      sample("a", "narrow", 1, { generation: undefined }),
      sample("b", "broad", 1, { project: {} }),
      sample("b", "narrow", 1, { project: {} }),
    ],
    2,
  );
  expect(s.comparablePairs).toBe(0);
  expect(s.pairs[0].reasons).toContain("generation_changed_between_arms");
  expect(s.pairs[1].reasons).toContain("project_changed_between_arms");
});
it("requires narrower canonical prefixes covering every original target", () => {
  expect(
    p.scopes(fixture, ["docs/services", "docs/modules"], root).narrow,
  ).toHaveLength(2);
  expect(() => p.scopes(fixture, ["docs/services"], root)).toThrow(
    "target_out_of_scope",
  );
  fs.symlinkSync(path.join(root, "docs"), path.join(root, "alias"));
  expect(() => p.scopes(fixture, ["alias"], root)).toThrow();
  const scoped = { ...fixture, prefixes: ["docs/services", "docs/modules"] };
  expect(() => p.scopes(scoped, ["docs"], root)).toThrow(
    "treatment_broadens_scope",
  );
});
it("alternates arm order, paces pairs and never retries unavailable samples", async () => {
  const prefixes = p.scopes(fixture, ["docs/services", "docs/modules"], root);
  const paths: string[][] = [],
    pauses: number[] = [];
  const client = {
    tool: async (name: string, args: any) => {
      if (name === "semantic_search") {
        expect(args.query).toBe("PRIVATE_QUERY_CANARY");
        paths.push(args.prefixes);
        return {
          contractVersion: 1,
          capabilities: caps,
          state: "host_pressure",
        };
      }
      const file = args.paths[0];
      return {
        contractVersion: 1,
        capabilities: caps,
        state: "ready",
        generation: 1,
        project: { root, store: "/fixture/store" },
        embeddingReady: true,
        queryState: "ready",
        coverage: { requested: 1, indexed: 1, partial: false },
        covered: [
          {
            path: file,
            hash: e.readSource(root, path.relative(root, file)).sha256,
            hashAlgorithm: "sha256-bytes",
          },
        ],
      };
    },
  };
  const samples = await p.runPairs({
    fixture,
    root,
    prefixes,
    client,
    onSample: () => {},
    pause: async (ms: number) => pauses.push(ms),
  });
  expect(paths).toEqual([
    prefixes.broad,
    prefixes.narrow,
    prefixes.narrow,
    prefixes.broad,
  ]);
  expect(pauses).toEqual([1000]);
  expect(samples).toHaveLength(4);
  expect(samples.map((s: any) => s.arm)).toEqual([
    "broad",
    "narrow",
    "narrow",
    "broad",
  ]);
  expect(JSON.stringify(samples)).not.toContain("PRIVATE_QUERY_CANARY");
});
it("the scope CLI checkpoints both arms with pointer provenance and no source/query bodies", () => {
  const entry = path.join(root, "bridge.cjs");
  fs.writeFileSync(
    entry,
    `
    const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),readline=require('node:readline');
    if(JSON.stringify(process.argv.slice(2))!=='["mcp","--existing-index-only"]')process.exit(2);
    const root=${JSON.stringify(root)},caps=${JSON.stringify(caps)},base={contractVersion:1,capabilities:caps,state:'ready',generation:1};
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);if(!m.id)return;let result;
      if(m.method==='initialize')result={protocolVersion:'2025-06-18',serverInfo:{name:'gmax-document-search'}};
      else if(m.method==='tools/list')result={tools:[{name:'document_search_status'},{name:'semantic_search'}]};
      else if(m.params.name==='document_search_status')result={structuredContent:{...base,project:{root,store:'/fixture/store'},embeddingReady:true,queryState:'ready',coverage:{requested:1,indexed:1,partial:false},covered:m.params.arguments.paths.map(p=>({path:p,hash:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),hashAlgorithm:'sha256-bytes'}))}};
      else{const p=path.join(root,'docs/services/one.md');result={structuredContent:{...base,root,store:'/fixture/store',matches:[{path:p,startLine:2,endLine:2,score:.8,hash:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),hashAlgorithm:'sha256-bytes'}]}};}
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });
  `,
  );
  const file = path.join(root, "fixture.json");
  fs.writeFileSync(file, JSON.stringify(fixture));
  const output = path.join(root, "paired.json");
  const args = [
    path.resolve("scripts/eval-document-scopes.cjs"),
    "--fixture",
    file,
    "--sha256",
    e.hash(fs.readFileSync(file)),
    "--root",
    root,
    "--entry",
    entry,
    "--output",
    output,
    "--narrow-prefix",
    "docs/services",
    "--narrow-prefix",
    "docs/modules",
  ];
  const run = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(run.status).toBe(0);
  const bytes = fs.readFileSync(output, "utf8");
  const report = JSON.parse(bytes);
  expect(report.summary.comparablePairs).toBe(2);
  expect(report.samples.map((s: any) => s.arm)).toEqual([
    "broad",
    "narrow",
    "narrow",
    "broad",
  ]);
  expect(report.samples[0].retrieval.pointers[0].indexedSha256).toBe(
    report.samples[0].retrieval.pointers[0].currentSourceSha256,
  );
  expect(bytes + run.stdout + run.stderr).not.toContain("PRIVATE_QUERY_CANARY");
  expect(bytes).not.toContain("Synthetic source");
  expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  expect(
    fs.readFileSync(`${output}.samples.jsonl`, "utf8").trim().split("\n"),
  ).toHaveLength(4);
  expect(spawnSync(process.execPath, args, { timeout: 5000 }).status).toBe(1);
});
