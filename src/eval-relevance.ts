/** Frozen local multi-corpus baseline, using the existing daemon with no fallback. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { open } from "lmdb";
import { PATHS } from "./config";
import {
  matchesTarget,
  parseFrozenFixture,
  type RelevanceSample,
  scoreRelevance,
  sha256,
  sourceExclusions,
  summarizeRelevance,
} from "./lib/eval/relevance-baseline";
import type { ChunkType, SearchResponse } from "./lib/store/types";
import {
  type DaemonResponse,
  sendDaemonCommand,
} from "./lib/utils/daemon-client";
import { listProjects } from "./lib/utils/project-registry";

function git(root: string) {
  try {
    return {
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
      dirty:
        execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim().length > 0,
    };
  } catch {
    return null;
  }
}

async function run() {
  const { values } = parseArgs({
    options: {
      fixture: { type: "string" },
      sha256: { type: "string" },
      output: { type: "string" },
      repeats: { type: "string", default: "2" },
      help: { type: "boolean" },
      diagnostics: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "pnpm bench:relevance --fixture <json> --sha256 <frozen-sha256> --output <new-json> [--repeats 2] [--diagnostics]",
    );
    return;
  }
  if (!values.fixture || !values.sha256 || !values.output)
    throw new Error("Required: --fixture, --sha256, --output");
  if (fs.existsSync(values.output))
    throw new Error("Output exists; use a new artifact path");
  const checkpoint = `${values.output}.samples.jsonl`;
  if (fs.existsSync(checkpoint))
    throw new Error("Checkpoint exists; use a new artifact path");
  const repeats = Number(values.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5)
    throw new Error("Repeats must be 1–5");
  const fixturePath = path.resolve(values.fixture);
  const fixture = parseFrozenFixture(
    fs.readFileSync(fixturePath),
    values.sha256,
  );
  const roots = new Map(
    fixture.corpora.map((r) => [
      r.id,
      fs.realpathSync(path.resolve(path.dirname(fixturePath), r.root)),
    ]),
  );
  const startedAt = new Date().toISOString();
  const ping = await sendDaemonCommand({ cmd: "ping" }, { timeoutMs: 5000 });
  if (!ping.ok || ping.ready !== true)
    throw new Error(
      "An already-ready daemon is required; no autostart/fallback",
    );
  if (
    values.diagnostics &&
    (ping.capabilities as Record<string, unknown> | undefined)
      ?.searchDiagnostics !== 1
  )
    throw new Error(
      "Daemon lacks searchDiagnostics v1; install/restart a compatible daemon before measuring diagnostics",
    );
  const before = await sendDaemonCommand({ cmd: "status" });
  if (!before.ok) throw new Error("Cannot capture daemon status");
  const registry = listProjects();
  const cache = open<{ hash: string; hasVectors?: boolean }>({
    path: path.join(PATHS.globalRoot, "cache/meta.lmdb"),
    compression: true,
    readOnly: true,
  });
  const samples: (RelevanceSample & Record<string, unknown>)[] = [];
  const preflight = [];
  fs.writeFileSync(checkpoint, "", { flag: "wx" });
  try {
    for (const corpus of fixture.corpora) {
      const root = roots.get(corpus.id)!;
      const project = registry.find((p) => p.root === root);
      if (project?.status !== "indexed")
        throw new Error(`Corpus is not indexed: ${corpus.id}`);
      const files = [
        ...new Set(
          fixture.cases
            .filter((c) => c.corpus === corpus.id)
            .flatMap((c) => c.expected.map((t) => t.file)),
        ),
      ];
      const rows = await sendDaemonCommand({
        cmd: "rows.locate",
        projectRoot: root,
        limit: 500,
        select: ["path", "defined_symbols", "start_line", "end_line"],
        matches: files.map((file) => ({ kind: "path", path: file })),
      });
      if (!rows.ok || !Array.isArray(rows.rows))
        throw new Error(`Target inventory failed: ${corpus.id}`);
      preflight.push({
        corpus: corpus.id,
        root,
        git: git(root),
        project,
        files,
        targetRows: rows.rows,
        cache: files.map((file) => ({
          file,
          ...cache.get(path.join(root, file)),
        })),
      });
    }
    // Sequential execution bounds load. Interleave corpora instead of running
    // all of one corpus first; repetitions are reported separately from cases.
    const ordered = [];
    const groups = fixture.corpora.map((r) =>
      fixture.cases.filter((c) => c.corpus === r.id),
    );
    for (let i = 0; i < Math.max(...groups.map((g) => g.length)); i++) {
      for (const group of groups) if (group[i]) ordered.push(group[i]);
    }
    for (let repetition = 1; repetition <= repeats; repetition++) {
      for (const c of ordered) {
        const root = roots.get(c.corpus)!;
        const exclusions = new Set<string>();
        const inventory = preflight.find((r) => r.corpus === c.corpus)!;
        for (const t of c.expected) {
          const file = path.join(root, t.file);
          if (fs.realpathSync(file) !== file)
            throw new Error(`Target aliases are not frozen: ${c.id}`);
          for (const reason of sourceExclusions(
            t.sourceSha256,
            sha256(fs.readFileSync(file)),
            cache.get(file)?.hash,
          ))
            exclusions.add(reason);
          const indexed = (inventory.targetRows as Record<string, unknown>[][])
            .flat()
            .some((row) =>
              matchesTarget(
                {
                  type: "text",
                  score: 0,
                  metadata: { path: String(row.path), hash: "" },
                  defined_symbols: row.defined_symbols as string[],
                  generated_metadata: {
                    start_line: Number(row.start_line),
                    num_lines:
                      Number(row.end_line) - Number(row.start_line) + 1,
                  },
                },
                root,
                t,
              ),
            );
          if (!indexed) exclusions.add("target_not_in_index");
        }
        const start = performance.now();
        const response: DaemonResponse =
          exclusions.size === 0
            ? await sendDaemonCommand(
                {
                  cmd: "search",
                  projectRoot: root,
                  query: c.query,
                  limit: 20,
                  pathPrefix: `${root}${path.sep}`,
                  rerank: false,
                  explain: true,
                  diagnostics: values.diagnostics,
                },
                { timeoutMs: 60_000 },
              )
            : { ok: false, error: "preflight_excluded" };
        const elapsedMs = performance.now() - start;
        if (
          values.diagnostics &&
          response.ok &&
          (response.diagnostics as { schemaVersion?: number } | undefined)
            ?.schemaVersion !== 1
        )
          exclusions.add("diagnostics_missing");
        if (!response.ok)
          exclusions.add(String(response.error ?? "search_failed"));
        const data = Array.isArray(response.data)
          ? (response.data as ChunkType[])
          : [];
        const state = response.indexState as
          | Record<string, unknown>
          | undefined;
        if (
          state &&
          (state.indexing ||
            state.verifying ||
            state.degraded ||
            Number(state.pendingFiles) > 0 ||
            Number(state.failedFiles) > 0)
        )
          exclusions.add("index_unsettled");
        const warnings = Array.isArray(response.warnings)
          ? response.warnings
          : [];
        if (warnings.length) exclusions.add("search_warning");
        for (const t of c.expected) {
          const file = path.join(root, t.file);
          for (const reason of sourceExclusions(
            t.sourceSha256,
            sha256(fs.readFileSync(file)),
            cache.get(file)?.hash,
          ))
            exclusions.add(reason);
          if (
            data.some(
              (d) =>
                d.metadata?.path === file && d.metadata.hash !== t.sourceSha256,
            )
          )
            exclusions.add("returned_row_hash_mismatch");
        }
        const ranked: SearchResponse = { data };
        samples.push({
          ...scoreRelevance(ranked, root, c),
          id: c.id,
          corpus: c.corpus,
          split: c.split,
          repetition,
          elapsedMs,
          exclusions: [...exclusions],
          query: c.query,
          intent: c.intent,
          origin: c.origin,
          warnings,
          indexState: state ?? null,
          error: response.ok ? null : response.error,
          diagnostics: response.diagnostics ?? null,
          results: data.map((d) => ({
            path: path.relative(root, String(d.metadata?.path ?? "")),
            hash: d.metadata?.hash ?? null,
            symbols: d.defined_symbols ?? [],
            range: d.generated_metadata ?? null,
            score: d.score,
            scoreBreakdown: d.scoreBreakdown ?? null,
          })),
        });
        fs.appendFileSync(
          checkpoint,
          `${JSON.stringify(samples[samples.length - 1])}\n`,
        );
        console.error(
          `${c.id} repeat=${repetition} rank=${samples[samples.length - 1].rank} excluded=${[...exclusions].join(",") || "none"}`,
        );
      }
    }
  } finally {
    cache.close();
  }
  const afterPing = await sendDaemonCommand({ cmd: "ping" });
  const after = await sendDaemonCommand({ cmd: "status" });
  if (
    !afterPing.ok ||
    after.pid !== before.pid ||
    afterPing.version !== ping.version
  ) {
    for (const sample of samples) sample.exclusions.push("daemon_changed");
  }
  if (sha256(fs.readFileSync(fixturePath)) !== values.sha256)
    throw new Error("Frozen fixture changed during execution");
  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    fixtureSha256: values.sha256,
    fixture,
    source: {
      git: git(process.cwd()),
      node: process.version,
      evaluatorHash: sha256(fs.readFileSync(__filename)),
      scoringHash: sha256(
        fs.readFileSync(path.join(__dirname, "lib/eval/relevance-baseline.ts")),
      ),
      searcherHash: sha256(
        fs.readFileSync(path.join(__dirname, "lib/search/searcher.ts")),
      ),
      diagnosticsHash: sha256(
        fs.readFileSync(path.join(__dirname, "lib/search/diagnostics.ts")),
      ),
    },
    execution: {
      transport: "existing-daemon-ipc",
      requestedRerank: false,
      explain: true,
      requestedDiagnostics: values.diagnostics,
      limit: 20,
      repeats,
      ping,
      before,
      afterPing,
      after,
      preflight,
      diagnostics: {
        fusionPool: values.diagnostics
          ? "bounded-post-seed-head-200"
          : "unobserved",
        concentrationGate: values.diagnostics
          ? "per-sample-diagnostics"
          : "unobserved",
        daemonRankingEnvironment: values.diagnostics
          ? "allowlisted-per-sample-diagnostics"
          : "unobserved",
        ftsHealth: values.diagnostics
          ? "per-sample-diagnostics"
          : "warnings-and-score-breakdowns-only",
        trueRerankOff: "not-asserted",
      },
    },
    summary: summarizeRelevance(samples),
    byCorpus: fixture.corpora.map((r) => ({
      corpus: r.id,
      ...summarizeRelevance(samples.filter((s) => s.corpus === r.id)),
    })),
    bySplit: ["dev", "heldout"].map((split) => ({
      split,
      ...summarizeRelevance(samples.filter((s) => s.split === split)),
    })),
    byIntent: [...new Set(fixture.cases.map((c) => c.intent))].map(
      (intent) => ({
        intent,
        ...summarizeRelevance(samples.filter((s) => s.intent === intent)),
      }),
    ),
    samples,
    researchGateReady: false,
    limitations: [
      "Curated source-grounded cases are not observed user-session misses",
      values.diagnostics
        ? "Candidate trace is limited to the post-seed fusion head; absence from a truncated trace does not prove retrieval failure"
        : "Pipeline diagnostics were not requested",
      "Client environment cannot change daemon ranking settings",
      "Latencies mix ordinary daemon activity and first/repeated queries",
    ],
  };
  fs.writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    JSON.stringify(
      {
        output: values.output,
        summary: report.summary,
        byCorpus: report.byCorpus,
        bySplit: report.bySplit,
      },
      null,
      2,
    ),
  );
  if (samples.some((s) => s.exclusions.length > 0)) process.exitCode = 2;
}

if (require.main === module)
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
