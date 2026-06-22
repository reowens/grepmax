/**
 * Navigation-precision fixture — the measurement gate for the type-position
 * reference cluster (chunker type-position edges, Phase 10 graph-distance,
 * `gmax dead` precision). Both standing plans defer that cluster behind one
 * unmet condition: a `trace --inbound` / `dead` truth set that EXISTS and
 * MOVES. This is that instrument.
 *
 * WHAT IT MEASURES. The call graph is built from tree-sitter call-expression
 * captures, so `referenced_symbols` holds call/construct sites (`foo()`,
 * `new Foo()`) but NOT type-position uses (`: Foo`, `<Foo>`, `extends Foo`,
 * `x as Foo`). `gmax trace --inbound Foo` and `gmax dead Foo` both read that
 * graph, so a type used purely in annotations looks like it has no callers —
 * trace under-reports, dead false-positives. This harness quantifies the gap by
 * contrast: call-position recall (the baseline the graph achieves on the shapes
 * it does capture) vs type-position recall (≈0 today).
 *
 * IT IS A GAUGE, NOT A PASS/FAIL GATE. Call-position recall is already <100%
 * (chunk rollup, uncaptured shapes) — that is the status quo, not a regression,
 * so the run always exits 0. The load-bearing number is type-position recall:
 * low today = standing evidence to build chunker type-position edges; re-run
 * after building them to confirm it moved. (For a true regression gate on the
 * call graph, see the caller-count guard in eval-graph-sanity.ts.)
 *
 * HOW IT STAYS HONEST (no rot). Ground truth is derived live: for each symbol,
 * `git grep` every reference and classify each file as a call-position caller or
 * a type-position-only caller; `getCallers` is the measured set. The only
 * hand-annotation is each symbol's character (callable vs type-only). The
 * harness excludes its own file from both grep and the graph so listing the
 * fixture symbols here can't contaminate the measurement. Run after a reindex.
 *
 * Usage:
 *   npx tsx src/eval-graph-nav.ts            # table output
 *   npx tsx src/eval-graph-nav.ts --json     # machine-readable
 */

process.env.GMAX_WORKER_COUNT ??= "1";

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { PATHS } from "./config";
import { GraphBuilder } from "./lib/graph/graph-builder";
import { VectorDB } from "./lib/store/vector-db";
import { gracefulExit } from "./lib/utils/exit";
import { escapeSqlString } from "./lib/utils/filter-builder";

const GMAX_ROOT = path.resolve(__dirname, "..");
const SELF = "src/eval-graph-nav.ts"; // exclude from grep + graph (self-reference)
const rel = (p: string) => p.replace(`${GMAX_ROOT}/`, "");

// "callable": reached via call/construct sites the graph captures — its
// call-position recall is the baseline. "type-only": used purely in type
// position — its type-position recall is the gap under measurement.
type Character = "callable" | "type-only";

interface NavSymbol {
  symbol: string;
  character: Character;
  note: string;
}

const INBOUND_SYMBOLS: NavSymbol[] = [
  // ── Baselines: called/constructed, so the graph captures them. ──────────────
  {
    symbol: "getWorkerPool",
    character: "callable",
    note: "plain function call sites",
  },
  {
    symbol: "GraphBuilder",
    character: "callable",
    note: "class via `new GraphBuilder(...)`",
  },
  {
    symbol: "withQueryTimeout",
    character: "callable",
    note: "wrapper function call sites",
  },
  {
    symbol: "isFileCached",
    character: "callable",
    note: "predicate function call sites",
  },
  // ── The gap: interfaces / type aliases used only in `: T` / `<T>` position. ──
  {
    symbol: "SearchResponse",
    character: "type-only",
    note: "return/param annotation across search + eval",
  },
  {
    symbol: "VectorRecord",
    character: "type-only",
    note: "row interface annotated across index/store/worker",
  },
  {
    symbol: "GraphNode",
    character: "type-only",
    note: "graph row interface in dead/formatter consumers",
  },
  {
    symbol: "NeighborHit",
    character: "type-only",
    note: "traversal interface, type position only",
  },
  {
    symbol: "CallerTree",
    character: "type-only",
    note: "recursive caller interface, type position only",
  },
  {
    symbol: "EdgeDirection",
    character: "type-only",
    note: "string-literal type alias, pure type position",
  },
];

// Dead-precision truth is derived (LIVE iff grep finds any use beyond def/import).
const DEAD_SYMBOLS = [
  "getWorkerPool", // LIVE baseline (call users) — dead must read LIVE
  "GraphBuilder", // LIVE baseline (construct users)
  "DeadResult", // non-exported, type-only users → today DEAD (false positive)
  "EdgeDirection", // exported, type-only users → today PUBLIC_EXPORT (masked)
  "ResolvedCaller", // exported, type-only users → today PUBLIC_EXPORT (masked)
];

type RefKind = "import" | "def" | "call" | "type" | "other";

function classify(symbol: string, text: string): RefKind {
  const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/\bimport\b/.test(text)) return "import";
  if (
    new RegExp(`\\b(interface|type|class|function|enum)\\s+${s}\\b`).test(text)
  )
    return "def";
  if (new RegExp(`\\b(const|let|var)\\s+${s}\\b\\s*[:=]`).test(text))
    return "def";
  if (new RegExp(`(\\bnew\\s+${s}\\b|\\b${s}\\s*\\()`).test(text))
    return "call";
  if (
    new RegExp(
      `([:<,|&(]\\s*${s}\\b|\\bextends\\s+${s}\\b|\\bimplements\\s+${s}\\b|\\bas\\s+${s}\\b|\\b${s}\\s*[[<])`,
    ).test(text)
  )
    return "type";
  return "other";
}

/**
 * Live ground truth for `symbol`: files that reference it from a call position
 * vs a type-only position. Definition-only / import-only files are not callers.
 * A file with any call site counts as a call caller even if it also uses the
 * symbol as a type (the graph should find it via the call). The harness's own
 * file is excluded so the fixture list can't contaminate the truth.
 */
function referenceTruth(symbol: string): {
  callFiles: Set<string>;
  typeOnlyFiles: Set<string>;
} {
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      ["grep", "-nwF", symbol, "--", "*.ts", "*.py", `:!${SELF}`],
      { cwd: GMAX_ROOT, encoding: "utf-8" },
    );
  } catch {
    return { callFiles: new Set(), typeOnlyFiles: new Set() };
  }
  const callFiles = new Set<string>();
  const typeFiles = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split(":");
    const file = parts[0];
    const text = parts.slice(2).join(":");
    const kind = classify(symbol, text);
    if (kind === "call") callFiles.add(file);
    else if (kind === "type") typeFiles.add(file);
  }
  const typeOnlyFiles = new Set(
    [...typeFiles].filter((f) => !callFiles.has(f)),
  );
  return { callFiles, typeOnlyFiles };
}

/** getCallers file set, excluding the harness's own (possibly stale) chunks. */
async function callerFiles(
  builder: GraphBuilder,
  symbol: string,
): Promise<Set<string>> {
  const callers = await builder.getCallers(symbol);
  return new Set(callers.map((g) => rel(g.file)).filter((f) => f !== SELF));
}

function recall(
  found: Set<string>,
  expected: Set<string>,
): { hit: number; total: number } {
  let hit = 0;
  for (const f of expected) if (found.has(f)) hit++;
  return { hit, total: expected.size };
}

interface InboundResult {
  symbol: string;
  character: Character;
  call: { hit: number; total: number };
  type: { hit: number; total: number };
  missedType: string[];
  note: string;
}

interface DeadResultRow {
  symbol: string;
  trueLive: boolean;
  status: "LIVE" | "DEAD" | "PUBLIC_EXPORT" | "NO_DEF";
  verdict: "correct" | "false-dead" | "masked-by-export" | "over-live";
}

async function runInbound(builder: GraphBuilder): Promise<InboundResult[]> {
  const out: InboundResult[] = [];
  for (const c of INBOUND_SYMBOLS) {
    const { callFiles, typeOnlyFiles } = referenceTruth(c.symbol);
    const found = await callerFiles(builder, c.symbol);
    out.push({
      symbol: c.symbol,
      character: c.character,
      call: recall(found, callFiles),
      type: recall(found, typeOnlyFiles),
      missedType: [...typeOnlyFiles].filter((f) => !found.has(f)),
      note: c.note,
    });
  }
  return out;
}

async function runDead(
  db: VectorDB,
  builder: GraphBuilder,
): Promise<DeadResultRow[]> {
  const table = await db.ensureTable();
  const out: DeadResultRow[] = [];
  for (const symbol of DEAD_SYMBOLS) {
    const { callFiles, typeOnlyFiles } = referenceTruth(symbol);
    const trueLive = callFiles.size + typeOnlyFiles.size > 0;
    const defRows = await table
      .query()
      .select(["is_exported"])
      .where(`array_contains(defined_symbols, '${escapeSqlString(symbol)}')`)
      .limit(1)
      .toArray();
    const found = await callerFiles(builder, symbol);
    let status: DeadResultRow["status"];
    if (defRows.length === 0) status = "NO_DEF";
    else if (found.size > 0) status = "LIVE";
    else status = (defRows[0] as any).is_exported ? "PUBLIC_EXPORT" : "DEAD";

    let verdict: DeadResultRow["verdict"];
    if (trueLive && status === "LIVE") verdict = "correct";
    else if (!trueLive && status === "DEAD") verdict = "correct";
    else if (trueLive && status === "DEAD") verdict = "false-dead";
    else if (trueLive && status === "PUBLIC_EXPORT")
      verdict = "masked-by-export";
    else verdict = "over-live";
    out.push({ symbol, trueLive, status, verdict });
  }
  return out;
}

function pool(rows: Array<{ hit: number; total: number }>): {
  hit: number;
  total: number;
  pct: number;
} {
  const hit = rows.reduce((a, r) => a + r.hit, 0);
  const total = rows.reduce((a, r) => a + r.total, 0);
  return { hit, total, pct: total === 0 ? 0 : (100 * hit) / total };
}

async function main() {
  const jsonMode =
    process.argv.includes("--json") || process.env.GMAX_EVAL_JSON === "1";
  const db = new VectorDB(PATHS.lancedbDir);
  const builder = new GraphBuilder(db, GMAX_ROOT);

  const inbound = await runInbound(builder);
  const dead = await runDead(db, builder);
  await db.close();

  const callBaseline = pool(
    inbound.filter((r) => r.character === "callable").map((r) => r.call),
  );
  const typeGap = pool(
    inbound.filter((r) => r.character === "type-only").map((r) => r.type),
  );
  const falseDead = dead.filter((r) => r.verdict === "false-dead").length;
  const maskedByExport = dead.filter(
    (r) => r.verdict === "masked-by-export",
  ).length;

  const summary = {
    callPositionRecall: callBaseline,
    typePositionRecall: typeGap,
    deadFalsePositives: falseDead,
    deadMaskedByExport: maskedByExport,
  };

  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify({ summary, inbound, dead }, null, 2)}\n`,
    );
    await gracefulExit(0);
    return;
  }

  const pct = (r: { hit: number; total: number }) =>
    r.total === 0
      ? "  n/a"
      : `${Math.round((100 * r.hit) / r.total)}%`.padStart(4);
  console.log(`Navigation-precision fixture (trace --inbound / dead)`);
  console.log(`root: ${GMAX_ROOT}\n`);

  console.log(
    `Inbound caller recall (getCallers vs grep truth, by reference position):`,
  );
  for (const r of inbound) {
    const tag = r.character === "callable" ? "callable " : "type-only";
    console.log(
      `  ${r.symbol.padEnd(16)} [${tag}] ` +
        `call ${pct(r.call)} (${String(r.call.hit).padStart(2)}/${String(r.call.total).padStart(2)})  ` +
        `type ${pct(r.type)} (${String(r.type.hit).padStart(2)}/${String(r.type.total).padStart(2)})` +
        (r.character === "type-only" && r.missedType.length
          ? `  misses: ${r.missedType.slice(0, 3).join(", ")}${r.missedType.length > 3 ? ", …" : ""}`
          : ""),
    );
  }

  console.log(`\nDead-code precision (truth derived from grep):`);
  for (const r of dead) {
    const flag =
      r.verdict === "false-dead"
        ? "  ← FALSE POSITIVE (really LIVE)"
        : r.verdict === "masked-by-export"
          ? "  ← type-only users hidden behind PUBLIC EXPORT"
          : "";
    console.log(
      `  ${r.symbol.padEnd(16)} truth=${(r.trueLive ? "LIVE" : "DEAD").padEnd(4)}  reported=${r.status.padEnd(13)}${flag}`,
    );
  }

  console.log(
    `\nHeadline` +
      `\n  call-position recall (baseline): ${callBaseline.hit}/${callBaseline.total} (${Math.round(callBaseline.pct)}%)` +
      `\n  type-position recall (the gap):  ${typeGap.hit}/${typeGap.total} (${Math.round(typeGap.pct)}%)` +
      `\n  dead false-positives: ${falseDead}   ·   dead masked-by-export: ${maskedByExport}`,
  );
  const delta = Math.round(callBaseline.pct - typeGap.pct);
  if (callBaseline.pct < 40) {
    console.log(
      `\nVerdict: INCONCLUSIVE — call-position baseline is unexpectedly low (${Math.round(callBaseline.pct)}%); ` +
        `the index may be stale. Reindex (gmax index) and re-run.`,
    );
  } else if (typeGap.pct < 50) {
    console.log(
      `\nVerdict: GAP OPEN (${delta} pts) — navigation recovers call sites at ${Math.round(callBaseline.pct)}% ` +
        `but type-position references at only ${Math.round(typeGap.pct)}%. Standing evidence to build chunker ` +
        `type-position edges; re-run after to confirm the gap closes.`,
    );
  } else {
    console.log(
      `\nVerdict: GAP CLOSING — type-position recall is up to ${Math.round(typeGap.pct)}% ` +
        `(call baseline ${Math.round(callBaseline.pct)}%).`,
    );
  }

  await gracefulExit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
