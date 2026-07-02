import { Command } from "commander";
import {
  analyzeSurprisingConnections,
  DEFAULT_SURPRISE_OPTIONS,
  findingBucketLabel,
  findingExamples,
  formatPenaltySummary,
  lineLabel,
  MAX_SURPRISE_ROWS,
  skeletonHint,
} from "../lib/analysis/surprising-connections";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const style = {
  bold: (s: string) => (useColors ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (useColors ? `\x1b[2m${s}\x1b[39m` : s),
  cyan: (s: string) => (useColors ? `\x1b[36m${s}\x1b[39m` : s),
};

function parseIntOption(
  value: unknown,
  fallback: number,
  max = 10_000,
): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseFloatOption(value: unknown, fallback: number): number {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function formatAgent(
  result: Awaited<ReturnType<typeof analyzeSurprisingConnections>>,
  top: number,
) {
  const lines: string[] = [];
  const { summary, findings } = result;
  lines.push(
    `summary\t${summary.sampledAnchors}\t${summary.codeRows}\t${summary.acceptedPairs}\t${summary.acceptedFilePairs}`,
  );
  for (const finding of findings.slice(0, top)) {
    const pair = finding.representative;
    lines.push(
      [
        "surprise",
        finding.score.toFixed(3),
        finding.maxSimilarity.toFixed(3),
        String(finding.pairCount),
        finding.fileA,
        finding.fileB,
        lineLabel(pair.source),
        lineLabel(pair.target),
        finding.reasons.join(","),
        `buckets=${findingBucketLabel(finding, summary.options.dirDepth)}`,
        `top_sims=${finding.topSimilarities.join(",")}`,
        `penalties=${formatPenaltySummary(pair.scoreParts)}`,
        `next=${skeletonHint(finding)}`,
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

function formatHuman(
  result: Awaited<ReturnType<typeof analyzeSurprisingConnections>>,
  top: number,
) {
  const { summary, findings } = result;
  const out: string[] = [];
  out.push(
    `${style.bold("Surprising connections")} ${style.dim("(experimental, embedding-similar but graph-disconnected file pairs)")}`,
  );
  out.push(
    style.dim(
      `  sampled ${summary.sampledAnchors}/${summary.codeRows} code chunks; accepted ${summary.acceptedPairs} chunk pairs across ${summary.acceptedFilePairs} file pairs`,
    ),
  );
  out.push(
    style.dim(
      `  score p50/p90/max ${summary.actionabilityScore.p50}/${summary.actionabilityScore.p90}/${summary.actionabilityScore.max}; graph file edges filtered ${summary.filters.graphEdge}`,
    ),
  );
  out.push("");

  if (findings.length === 0) {
    out.push(style.dim("  none"));
    return out.join("\n");
  }

  for (const finding of findings.slice(0, top)) {
    const pair = finding.representative;
    out.push(
      `  ${style.cyan(`score=${finding.score.toFixed(3)}`)} sim=${finding.maxSimilarity.toFixed(3)} pairs=${finding.pairCount}  ${finding.fileA}`,
    );
    out.push(`      <-> ${finding.fileB}`);
    out.push(
      `      best: ${lineLabel(pair.source)} <-> ${lineLabel(pair.target)}`,
    );
    out.push(
      `      detail: no static file edge; buckets=${findingBucketLabel(
        finding,
        summary.options.dirDepth,
      )}; top_sims=${finding.topSimilarities.join(",")}`,
    );
    out.push(
      `      reasons: ${finding.reasons.join(", ") || "none"}; penalties=${formatPenaltySummary(
        pair.scoreParts,
      )}`,
    );
    const examples = findingExamples(finding, 2);
    if (examples.length > 1) {
      out.push(
        `      examples: ${examples
          .map(
            (example) =>
              `${lineLabel(example.source)} <-> ${lineLabel(example.target)}`,
          )
          .join("; ")}`,
      );
    }
    out.push(`      next: ${skeletonHint(finding)}`);
  }
  return out.join("\n");
}

export const surprises = new Command("surprises")
  .description(
    "Experimental: find embedding-similar cross-directory file pairs not already connected by the static graph",
  )
  .option(
    "--experimental",
    "Required acknowledgement for this experimental signal",
    false,
  )
  .option("--root <dir>", "Project root directory")
  .option(
    "--sample <n>",
    "How many indexed code chunks to sample",
    String(DEFAULT_SURPRISE_OPTIONS.sample),
  )
  .option(
    "--neighbors <n>",
    "Nearest neighbors to inspect per sampled chunk",
    String(DEFAULT_SURPRISE_OPTIONS.neighbors),
  )
  .option("--top <n>", "How many grouped findings to show", "20")
  .option(
    "--dir-depth <n>",
    "Directory bucket depth considered unsurprising",
    String(DEFAULT_SURPRISE_OPTIONS.dirDepth),
  )
  .option(
    "--min-sim <n>",
    "Minimum similarity 0-1",
    String(DEFAULT_SURPRISE_OPTIONS.minSimilarity),
  )
  .option(
    "--max-rows <n>",
    `Maximum indexed rows to scan (capped at ${MAX_SURPRISE_ROWS})`,
    String(DEFAULT_SURPRISE_OPTIONS.maxRows),
  )
  .option("--include-tests", "Include test files", false)
  .option("--include-eval", "Include eval/experiment/script files", false)
  .option(
    "--in <subpath>",
    "Restrict to a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option(
    "--exclude <subpath>",
    "Exclude a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option("--agent", "Compact TSV output for AI agents", false)
  .action(async (opts) => {
    if (!opts.experimental) {
      const msg =
        "`gmax surprises` is experimental; rerun with --experimental.";
      console.error(opts.agent ? `error\texperimental_required\t${msg}` : msg);
      process.exitCode = 1;
      return;
    }

    let vectorDb: VectorDB | null = null;
    try {
      const root = resolveRootOrExit(opts.root);
      if (root === null) return;
      const projectRoot = findProjectRoot(root) ?? root;
      maybeWarnStaleChunker(projectRoot, { agent: opts.agent });
      maybeWarnStaleEmbedding(projectRoot, { agent: opts.agent });
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);
      const table = await vectorDb.ensureTable();
      const top = parseIntOption(opts.top, 20, 100);

      const result = await analyzeSurprisingConnections(table, projectRoot, {
        sample: parseIntOption(opts.sample, DEFAULT_SURPRISE_OPTIONS.sample),
        neighbors: parseIntOption(
          opts.neighbors,
          DEFAULT_SURPRISE_OPTIONS.neighbors,
          200,
        ),
        dirDepth: parseIntOption(
          opts.dirDepth,
          DEFAULT_SURPRISE_OPTIONS.dirDepth,
          20,
        ),
        minSimilarity: parseFloatOption(
          opts.minSim,
          DEFAULT_SURPRISE_OPTIONS.minSimilarity,
        ),
        maxRows: parseIntOption(
          opts.maxRows,
          DEFAULT_SURPRISE_OPTIONS.maxRows,
          MAX_SURPRISE_ROWS,
        ),
        includeTests: Boolean(opts.includeTests),
        includeEval: Boolean(opts.includeEval),
        in: opts.in,
        exclude: opts.exclude,
      });

      console.log(
        opts.agent ? formatAgent(result, top) : formatHuman(result, top),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Surprises failed:", msg);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch {}
      }
      await gracefulExit();
    }
  });
