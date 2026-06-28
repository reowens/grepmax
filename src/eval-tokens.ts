// Reduce worker pool fan-out during eval to avoid ONNX concurrency issues.
// Must run before importing modules that read GMAX_WORKER_COUNT (mirrors eval.ts).
process.env.GMAX_WORKER_COUNT ??= "1";

// Token-savings benchmark — sibling to eval.ts.
//
// eval.ts measures Recall@10/MRR only; it never measures the "fewer tokens"
// value prop. This harness does, over the SAME 98 `cases` (imported from
// eval.ts), with an honest, conservative methodology:
//
//   Baseline (no gmax — what a grep-then-Read agent pays): read the WHOLE first
//     `expectedPath` file → estTokens(content). One file UNDER-counts (after a
//     grep an agent typically reads several), so every reported ratio is a
//     conservative FLOOR, not a best case.
//
//   gmax pointer: searcher.search(query, 20, {rerank}) rendered through
//     formatMcpPointerSearchResults(..., { query }) — the REAL bytes the
//     `semantic_search detail:pointer` view returns, not an idealized chunk.
//
//   gmax pointer+symbol: pointer bytes PLUS the top hit's symbol body, obtained
//     by slicing the top result's file on its [startLine..endLine] range. That
//     is what `extract_symbol` fundamentally returns (the symbol's line span),
//     with zero dependency on non-importable MCP handler internals.
//
// We deliberately REJECT graphify's "70×/100×" methodology: it compares one
// query to reading the ENTIRE corpus (corpus_words = nodes*50, benchmark.py:113),
// which no agent ever does. Whole-file Read is the baseline an agent actually pays.
//
// estTokens is a chars/4 proxy (mirrors mcp.ts:2216), NOT a real tokenizer. Both
// sides use the same estimator, so the RATIO is largely estimator-invariant — no
// tokenizer dependency is warranted.
//
// Preconditions (identical to eval.ts): an indexed store for cwd AND query
// embeddings available (MLX :8100 or the ONNX CPU fallback).
//
// Output: dual-mode like eval.ts — GMAX_EVAL_JSON=1 / --json emits a single JSON
// object on stdout (human preamble routed to stderr); otherwise human-readable.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatMcpPointerSearchResults,
  searchResultEndLine,
  searchResultPath,
  searchResultStartLine,
} from "./commands/mcp";
import { cases } from "./eval";
import { Searcher } from "./lib/search/searcher";
import { VectorDB } from "./lib/store/vector-db";
import { gracefulExit } from "./lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "./lib/utils/project-root";

const topK = 20;

// chars/4 proxy — mirrors the estimator in mcp.ts:2216. Not a tokenizer; fine
// here because BOTH sides use it, so the ratio is largely estimator-invariant.
const estTokens = (s: string) => Math.ceil(s.length / 4);

type TokenResult = {
  query: string;
  expectedPath: string;
  baselineTokens: number;
  pointerTokens: number;
  symbolTokens: number;
  pointerSymbolTokens: number;
  symbolLabel: string;
  topHitPath: string;
  ratioPointer: number;
  ratioPointerSymbol: number;
  skipped: boolean;
  note?: string;
};

// Linear-interpolation quantile over an ascending-sorted array.
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedAsc[base + 1];
  return next !== undefined
    ? sortedAsc[base] + rest * (next - sortedAsc[base])
    : sortedAsc[base];
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function aggregate(ratios: number[]) {
  const sorted = [...ratios].sort((a, b) => a - b);
  return {
    medianRatio: Number(quantile(sorted, 0.5).toFixed(2)),
    p25: Number(quantile(sorted, 0.25).toFixed(2)),
    p75: Number(quantile(sorted, 0.75).toFixed(2)),
    meanRatio: Number(mean(sorted).toFixed(2)),
  };
}

async function run() {
  const root = process.cwd();
  const projectRoot = findProjectRoot(root) ?? root;
  const paths = ensureProjectPaths(projectRoot);
  const vectorDb = new VectorDB(paths.lancedbDir);
  const searcher = new Searcher(vectorDb);

  const jsonMode =
    process.env.GMAX_EVAL_JSON === "1" || process.argv.includes("--json");
  // In JSON mode all human preamble goes to stderr so stdout stays one object.
  const log = jsonMode ? console.error : console.log;

  // Same precondition as eval.ts: bail loudly if the store is empty.
  if (!(await vectorDb.hasAnyRows())) {
    console.error("❌ Store appears to be empty!");
    console.error('   Run "gmax index" to populate the store with data.');
    process.exit(1);
  }

  // Rerank OFF by default (matches eval.ts) — set GMAX_EVAL_RERANK=1 to measure
  // the full production pipeline. Rendered bytes barely move with rerank; the
  // flag is here so token numbers line up with whichever recall run they sit next to.
  const rerank = process.env.GMAX_EVAL_RERANK === "1";

  log("Starting token-savings benchmark...\n");

  const results: TokenResult[] = [];

  for (const c of cases) {
    // Baseline: a grep-then-Read agent reads the whole first expectedPath file.
    // Pipe-split mirrors evaluateCase's path handling (eval.ts:552-555).
    const firstExpected = c.expectedPath.split("|")[0].trim();
    let baselineTokens = 0;
    let baselineOk = false;
    try {
      const content = readFileSync(join(projectRoot, firstExpected), "utf8");
      baselineTokens = estTokens(content);
      baselineOk = true;
    } catch {
      // Fixture path not present in this checkout — excluded from aggregation.
    }

    // gmax pointer: the real rendered bytes of the detail:pointer view.
    const res = await searcher.search(c.query, topK, { rerank });
    const pointerText = formatMcpPointerSearchResults(res.data, projectRoot, {
      query: c.query,
    });
    const pointerTokens = estTokens(pointerText);

    // gmax pointer+symbol: pointer bytes plus the top hit's symbol body, sliced
    // by its [startLine..endLine] range (0-based; mcp.ts:482 adds 1 for display).
    let symbolTokens = 0;
    let symbolLabel = "";
    let topHitPath = "";
    const top = res.data[0];
    if (top) {
      const absPath = searchResultPath(top);
      topHitPath = absPath;
      const start = searchResultStartLine(top);
      const end = searchResultEndLine(top, start);
      try {
        const lines = readFileSync(absPath, "utf8").split("\n");
        symbolTokens = estTokens(lines.slice(start, end + 1).join("\n"));
        symbolLabel =
          (top as { defined_symbols?: string[] }).defined_symbols?.[0] ?? "";
      } catch {
        // Top-hit file unreadable — symbol cost stays 0 (pointer-only).
      }
    }
    const pointerSymbolTokens = pointerTokens + symbolTokens;

    const skipped = !baselineOk;
    results.push({
      query: c.query,
      expectedPath: c.expectedPath,
      baselineTokens,
      pointerTokens,
      symbolTokens,
      pointerSymbolTokens,
      symbolLabel,
      topHitPath,
      ratioPointer:
        skipped || pointerTokens === 0 ? 0 : baselineTokens / pointerTokens,
      ratioPointerSymbol:
        skipped || pointerSymbolTokens === 0
          ? 0
          : baselineTokens / pointerSymbolTokens,
      skipped,
      note: skipped ? "baseline file missing" : undefined,
    });
  }

  const evaluated = results.filter((r) => !r.skipped);
  const pointerAgg = aggregate(evaluated.map((r) => r.ratioPointer));
  const pointerSymbolAgg = aggregate(
    evaluated.map((r) => r.ratioPointerSymbol),
  );

  const summary = {
    cases: results.length,
    evaluated: evaluated.length,
    skipped: results.length - evaluated.length,
    rerank,
    estimator: "chars/4 proxy (mirrors mcp.ts:2216)",
    baseline:
      "whole-file Read of first expectedPath — conservative floor (agents read several files after a grep)",
    pointer: pointerAgg,
    pointerSymbol: pointerSymbolAgg,
    storePath: paths.lancedbDir,
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
  } else {
    const fmt = (n: number) => `${n.toFixed(1)}×`;
    console.log("=".repeat(80));
    console.log(`Token-savings benchmark — store: ${paths.lancedbDir}`);
    console.log(
      "Baseline = whole-file Read of first expectedPath (chars/4, conservative floor)",
    );
    console.log("=".repeat(80));
    for (const r of results) {
      if (r.skipped) {
        console.log(`⏭  ${r.query}`);
        console.log(`   => skipped (${r.note}: ${r.expectedPath})`);
        continue;
      }
      console.log(r.query);
      console.log(
        `   baseline ${r.baselineTokens} tok  |  pointer ${r.pointerTokens} tok (${fmt(r.ratioPointer)})  |  +symbol ${r.pointerSymbolTokens} tok (${fmt(r.ratioPointerSymbol)})`,
      );
    }
    console.log("=".repeat(80));
    console.log(
      `gmax pointer        median ${fmt(pointerAgg.medianRatio)}  (p25 ${fmt(pointerAgg.p25)} · p75 ${fmt(pointerAgg.p75)} · mean ${fmt(pointerAgg.meanRatio)})`,
    );
    console.log(
      `gmax pointer+symbol median ${fmt(pointerSymbolAgg.medianRatio)}  (p25 ${fmt(pointerSymbolAgg.p25)} · p75 ${fmt(pointerSymbolAgg.p75)} · mean ${fmt(pointerSymbolAgg.meanRatio)})`,
    );
    console.log(
      `Evaluated ${evaluated.length}/${results.length} cases` +
        (summary.skipped ? ` (${summary.skipped} skipped: file missing)` : ""),
    );
    console.log(
      "Estimator: chars/4 proxy — ratio is estimator-invariant. Single-file baseline under-counts → floor.",
    );
    console.log("=".repeat(80));
  }

  await gracefulExit(0);
}

if (
  // Only auto-run when executed directly (not when imported for experiments/tests)
  require.main === module &&
  process.env.GMAX_EVAL_AUTORUN !== "0"
) {
  run().catch((err) => {
    console.error("Token benchmark failed:", err);
    gracefulExit(1);
  });
}
