/**
 * Measure-first prototype for Graphify Phase 3 "surprising connections".
 *
 * It samples indexed code chunks, asks LanceDB for each chunk's nearest vector
 * neighbors, then filters out pairs that are already obvious. Output is grouped
 * by file pair and scored for actionability. This is deliberately an eval
 * harness; the product surface is `gmax surprises --experimental`.
 *
 * Run:
 *   pnpm bench:surprises
 *   pnpm bench:surprises -- --sample 300 --neighbors 25 --top 30
 *   pnpm bench:surprises:json
 */

import * as path from "node:path";
import {
  analyzeSurprisingConnections,
  DEFAULT_SURPRISE_OPTIONS,
  lineLabel,
} from "./lib/analysis/surprising-connections";
import { VectorDB } from "./lib/store/vector-db";
import { gracefulExit } from "./lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "./lib/utils/project-root";

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function argValues(name: string): string[] | undefined {
  const values: string[] = [];
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === name && process.argv[i + 1]) {
      values.push(process.argv[i + 1]);
      i++;
    } else if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length));
    }
  }
  return values.length > 0 ? values : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function intOpt(name: string, envName: string, fallback: number): number {
  const raw = argValue(name) ?? process.env[envName];
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function floatOpt(name: string, envName: string, fallback: number): number {
  const raw = argValue(name) ?? process.env[envName];
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function run() {
  const root = path.resolve(argValue("--root") ?? process.cwd());
  const projectRoot = findProjectRoot(root) ?? root;
  const paths = ensureProjectPaths(projectRoot);
  const vectorDb = new VectorDB(paths.lancedbDir);
  const table = await vectorDb.ensureTable();
  const top = intOpt("--top", "GMAX_SURPRISE_TOP", 25);
  const json = hasFlag("--json") || process.env.GMAX_EVAL_JSON === "1";
  const log = json ? console.error : console.log;

  const result = await analyzeSurprisingConnections(table, projectRoot, {
    sample: intOpt(
      "--sample",
      "GMAX_SURPRISE_SAMPLE",
      DEFAULT_SURPRISE_OPTIONS.sample,
    ),
    neighbors: intOpt(
      "--neighbors",
      "GMAX_SURPRISE_NEIGHBORS",
      DEFAULT_SURPRISE_OPTIONS.neighbors,
    ),
    dirDepth: intOpt(
      "--dir-depth",
      "GMAX_SURPRISE_DIR_DEPTH",
      DEFAULT_SURPRISE_OPTIONS.dirDepth,
    ),
    minSimilarity: floatOpt(
      "--min-sim",
      "GMAX_SURPRISE_MIN_SIM",
      DEFAULT_SURPRISE_OPTIONS.minSimilarity,
    ),
    maxRows: intOpt(
      "--max-rows",
      "GMAX_SURPRISE_MAX_ROWS",
      DEFAULT_SURPRISE_OPTIONS.maxRows,
    ),
    includeTests: hasFlag("--include-tests"),
    includeEval: hasFlag("--include-eval"),
    in: argValues("--in"),
    exclude: argValues("--exclude"),
  });
  const { summary, findings } = result;
  const topFindings = findings.slice(0, top);

  log(
    `Surprising-connections prototype: ${summary.sampledAnchors} sampled chunks from ${summary.codeRows} code chunks (${summary.rows} indexed rows)`,
  );

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          summary,
          findings: topFindings.map((finding) => ({
            score: finding.score,
            maxSimilarity: finding.maxSimilarity,
            medianSimilarity: finding.medianSimilarity,
            pairCount: finding.pairCount,
            files: [finding.fileA, finding.fileB],
            reasons: finding.reasons,
            topSimilarities: finding.topSimilarities,
            representative: {
              similarity: Number(finding.representative.similarity.toFixed(3)),
              distance: Number(finding.representative.distance.toFixed(3)),
              scoreParts: finding.representative.scoreParts,
              source: {
                file: finding.representative.source.relPath,
                line: finding.representative.source.startLine + 1,
                symbols: finding.representative.source.definedSymbols.slice(
                  0,
                  4,
                ),
                role: finding.representative.source.role,
              },
              target: {
                file: finding.representative.target.relPath,
                line: finding.representative.target.startLine + 1,
                symbols: finding.representative.target.definedSymbols.slice(
                  0,
                  4,
                ),
                role: finding.representative.target.role,
              },
            },
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    console.log("\nSummary");
    console.log(`  project: ${projectRoot}`);
    console.log(`  rows/code rows: ${summary.rows}/${summary.codeRows}`);
    console.log(`  sampled anchors: ${summary.sampledAnchors}`);
    console.log(`  graph file edges: ${summary.graphFileEdges}`);
    console.log(
      `  accepted pairs/file-pairs: ${summary.acceptedPairs}/${summary.acceptedFilePairs}`,
    );
    console.log(
      `  similarity p50/p90/max: ${summary.similarity.p50}/${summary.similarity.p90}/${summary.similarity.max}`,
    );
    console.log(
      `  score p50/p90/max: ${summary.actionabilityScore.p50}/${summary.actionabilityScore.p90}/${summary.actionabilityScore.max}`,
    );
    console.log(
      `  filtered: same-file ${summary.filters.sameFile}, same-dir ${summary.filters.sameDirBucket}, graph-edge ${summary.filters.graphEdge}, tests ${summary.filters.tests}`,
    );

    console.log("\nTop grouped surprising connections");
    if (topFindings.length === 0) {
      console.log("  none");
    } else {
      for (const finding of topFindings) {
        const pair = finding.representative;
        console.log(
          `  score=${finding.score.toFixed(3)} sim=${finding.maxSimilarity.toFixed(3)} pairs=${finding.pairCount}  ${finding.fileA}`,
        );
        console.log(`      <-> ${finding.fileB}`);
        console.log(
          `      best: ${lineLabel(pair.source)} <-> ${lineLabel(pair.target)}`,
        );
        console.log(`      reasons: ${finding.reasons.join(", ") || "none"}`);
      }
    }
  }

  await vectorDb.close();
  await gracefulExit(0);
}

run().catch(async (error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  await gracefulExit(1);
});
