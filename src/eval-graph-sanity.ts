/**
 * Graph sanity checks.
 *
 * Default mode — caller-count guard (regression net for the chunker-v2 /
 * call-site-dedup fix). Before that fix, `splitIfTooBig` copied a parent
 * chunk's full `referenced_symbols` onto every sub-chunk, so `getCallers`
 * multiplied chunk rows: a symbol with 3 real call sites reported 66 callers
 * (22x). For a set of known gmax symbols this asserts `getCallers`' raw count
 * stays within a small multiple of grep-truth (word-boundary line matches
 * across tracked source). Exits nonzero if any symbol blows past the ceiling.
 * Run after a reindex so the index matches the working tree.
 *
 *   npx tsx src/eval-graph-sanity.ts
 *
 * Platform mode (--platform) — the original Phase 0 probe for Bundle B G1'
 * (graph-as-recall-recovery). For each platform hard-miss case (BeyondError,
 * ErrorCodes, resolveActor, errorHandler), mirror the searcher's dense+FTS+RRF
 * pipeline to the post-fusion top-200 pool, then count how many of those chunks
 * carry the target in `referenced_symbols`. ≥1 hit = a 1-hop outbound graph
 * walk can recover the target → worth building the recovery layer; 0 across all
 * 4 = the signal isn't in the graph at this depth. Requires
 * ~/Development/beyond/platform to be indexed.
 *
 *   npx tsx src/eval-graph-sanity.ts --platform
 */

process.env.GMAX_WORKER_COUNT ??= "1";

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { PATHS } from "./config";
import { resolveCallSites } from "./lib/graph/callsites";
import { GraphBuilder } from "./lib/graph/graph-builder";
import { VectorDB } from "./lib/store/vector-db";
import { gracefulExit } from "./lib/utils/exit";
import { escapeSqlString } from "./lib/utils/filter-builder";
import { getWorkerPool } from "./lib/workers/pool";

const PLATFORM_ROOT = path.join(
  process.env.HOME ?? "",
  "Development/beyond/platform",
);

const HARD_MISS_TARGETS = [
  "BeyondError",
  "ErrorCodes",
  "resolveActor",
  "errorHandler",
];

const PRE_K = 500;
const STAGE1_K = 200;
const RRF_K = 60;

function toStringArray(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.filter((v): v is string => typeof v === "string");
  }
  const maybe = val as { toArray?: () => unknown };
  if (typeof maybe.toArray === "function") {
    try {
      const arr = maybe.toArray();
      return Array.isArray(arr)
        ? arr.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function probe(target: string) {
  const db = new VectorDB(PATHS.lancedbDir);
  const table = await db.ensureTable();
  const pool = getWorkerPool();
  const { dense } = await pool.encodeQuery(target);

  const pathPrefix = PLATFORM_ROOT.endsWith("/")
    ? PLATFORM_ROOT
    : `${PLATFORM_ROOT}/`;
  const where = `path LIKE '${escapeSqlString(pathPrefix)}%'`;

  const columns = [
    "id",
    "path",
    "chunk_index",
    "start_line",
    "end_line",
    "defined_symbols",
    "referenced_symbols",
  ];

  const vectorRows = (await table
    .vectorSearch(dense)
    .select([...columns, "_distance"])
    .where(where)
    .limit(PRE_K)
    .toArray()) as Record<string, unknown>[];

  let ftsRows: Record<string, unknown>[] = [];
  try {
    ftsRows = (await table
      .search(target)
      .select([...columns, "_score"])
      .where(where)
      .limit(PRE_K)
      .toArray()) as Record<string, unknown>[];
  } catch (e) {
    console.warn(
      `[sanity] FTS unavailable for "${target}": ${(e as Error).message}`,
    );
  }

  const candidateScores = new Map<string, number>();
  const docMap = new Map<string, Record<string, unknown>>();

  vectorRows.forEach((doc, rank) => {
    const key =
      (doc.id as string | undefined) || `${doc.path}:${doc.chunk_index}`;
    docMap.set(key, doc);
    candidateScores.set(
      key,
      (candidateScores.get(key) || 0) + 1.0 / (RRF_K + rank + 1),
    );
  });
  ftsRows.forEach((doc, rank) => {
    const key =
      (doc.id as string | undefined) || `${doc.path}:${doc.chunk_index}`;
    if (!docMap.has(key)) docMap.set(key, doc);
    candidateScores.set(
      key,
      (candidateScores.get(key) || 0) + 1.0 / (RRF_K + rank + 1),
    );
  });

  const fused = Array.from(candidateScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, STAGE1_K)
    .map(([key]) => docMap.get(key)!)
    .filter(Boolean);

  let withRef = 0;
  let withDef = 0;
  let rankOfFirstRef = -1;
  let rankOfFirstDef = -1;
  const sampleRefHits: Array<{ rank: number; path: string }> = [];
  fused.forEach((doc, i) => {
    const refs = toStringArray(doc.referenced_symbols);
    const defs = toStringArray(doc.defined_symbols);
    if (refs.includes(target)) {
      withRef++;
      if (rankOfFirstRef < 0) rankOfFirstRef = i + 1;
      if (sampleRefHits.length < 3) {
        sampleRefHits.push({ rank: i + 1, path: String(doc.path) });
      }
    }
    if (defs.includes(target)) {
      withDef++;
      if (rankOfFirstDef < 0) rankOfFirstDef = i + 1;
    }
  });

  await db.close();

  return {
    target,
    poolSize: fused.length,
    vectorRows: vectorRows.length,
    ftsRows: ftsRows.length,
    withRef,
    withDef,
    rankOfFirstRef,
    rankOfFirstDef,
    sampleRefHits,
  };
}

async function platformProbe() {
  console.log(
    `Phase 0 sanity check — graph reachability on platform hard-miss cases`,
  );
  console.log(`pathPrefix: ${PLATFORM_ROOT}`);
  console.log(`STAGE1_K=${STAGE1_K}, PRE_K=${PRE_K}\n`);

  let anyReachable = false;
  const summary: Array<Awaited<ReturnType<typeof probe>>> = [];
  for (const target of HARD_MISS_TARGETS) {
    const res = await probe(target);
    summary.push(res);
    const refOK = res.withRef > 0 ? "✓" : "✗";
    const defOK = res.withDef > 0 ? "✓" : "✗";
    console.log(
      `${refOK} ${target.padEnd(16)} pool=${String(res.poolSize).padStart(3)}  ` +
        `refs=${String(res.withRef).padStart(3)}/200  defs=${defOK} (${res.withDef})  ` +
        `1st-ref@${res.rankOfFirstRef > 0 ? res.rankOfFirstRef : "—"}  ` +
        `1st-def@${res.rankOfFirstDef > 0 ? res.rankOfFirstDef : "—"}`,
    );
    for (const s of res.sampleRefHits) {
      console.log(`    ↳ rank ${s.rank}: ${s.path}`);
    }
    if (res.withRef > 0) anyReachable = true;
  }

  console.log(
    `\nVerdict: ${anyReachable ? "BUILD (≥1 case has graph signal in top-200)" : "ABORT (graph is empty at this depth — pick a different mechanism)"}`,
  );

  console.log(`\nJSON:`);
  console.log(JSON.stringify(summary, null, 2));
}

// ---------------------------------------------------------------------------
// Caller-count guard (default mode)
// ---------------------------------------------------------------------------

const GMAX_ROOT = path.resolve(__dirname, "..");

/**
 * Distinctive gmax symbols with a spread of real usage. All sit comfortably
 * below getCallers' internal `.limit(100)`, so the cap can never silently mask
 * an explosion — if the chunker regresses, the raw count blows past the
 * ceiling rather than getting clamped to 100. Names are intentionally unusual
 * (no bare words) so `git grep -w` truth isn't polluted by unrelated matches.
 */
const GUARD_SYMBOLS = [
  "resolveCallSites",
  "findCallSiteSnippet",
  "withQueryTimeout",
  "isFileCached",
  "getWorkerPool",
  "isBuiltinCallee",
  "findDependents",
  "buildFileSubgraph",
];

/**
 * getCallers returns one chunk-row per referencing chunk. Healthy, that count
 * is ≤ the number of source lines mentioning the symbol (several mentions in
 * one chunk collapse to one row; def/import lines aren't call references). So
 * the healthy ratio is ≤ ~1. A small multiple absorbs index-vs-worktree skew
 * and chunk-boundary splits while still catching the 22x chunker-v2 blowup.
 */
const CEILING_MULTIPLE = 3;

/** Mirror of getCallers' internal `.limit(100)` — at the cap the guard is blind. */
const CALLER_LIMIT = 100;

/**
 * grep-truth: word-boundary line + file counts for `symbol` across tracked
 * `.ts` (repo-wide, so experiments/ and scripts/ count too — they're indexed).
 * `git grep` skips gitignored paths (dist/), matching the indexed corpus.
 */
function grepTruth(symbol: string): { lines: number; files: number } {
  let out: string;
  try {
    out = execFileSync("git", ["grep", "-Fwc", symbol, "--", "*.ts"], {
      cwd: GMAX_ROOT,
      encoding: "utf-8",
    });
  } catch {
    // git grep exits 1 when there are zero matches.
    return { lines: 0, files: 0 };
  }
  let lines = 0;
  let files = 0;
  for (const row of out.split("\n")) {
    const idx = row.lastIndexOf(":");
    if (idx < 0) continue;
    const n = Number(row.slice(idx + 1));
    if (Number.isFinite(n) && n > 0) {
      lines += n;
      files++;
    }
  }
  return { lines, files };
}

async function callerCountGuard(): Promise<boolean> {
  const db = new VectorDB(PATHS.lancedbDir);
  await db.ensureTable();
  const builder = new GraphBuilder(db, GMAX_ROOT);
  const fileCache = new Map<string, string[]>();

  console.log(`Caller-count guard — getCallers vs grep-truth call sites`);
  console.log(`root: ${GMAX_ROOT}`);
  console.log(
    `ceiling = ${CEILING_MULTIPLE}x grep lines · getCallers cap = ${CALLER_LIMIT}`,
  );
  console.log(`(run after a reindex so the index matches the working tree)\n`);

  let allOK = true;
  for (const sym of GUARD_SYMBOLS) {
    const { lines: grepLines, files: grepFiles } = grepTruth(sym);
    const callers = await builder.getCallers(sym);
    const raw = callers.length;
    const deduped = resolveCallSites(
      callers.map((c) => ({ symbol: c.symbol, file: c.file, line: c.line })),
      sym,
      fileCache,
    ).length;

    const ceiling = CEILING_MULTIPLE * Math.max(1, grepLines);
    const capped = raw >= CALLER_LIMIT;
    const ratio = grepLines > 0 ? raw / grepLines : raw;
    // capped is a failure too: the fixture grew too common, so the cap now
    // hides explosions — swap it for a lower-usage symbol.
    const ok = !capped && raw <= ceiling;
    if (!ok) allOK = false;

    console.log(
      `${ok ? "✓" : "✗"} ${sym.padEnd(20)} ` +
        `callers=${String(raw).padStart(3)} (dedup ${String(deduped).padStart(3)})  ` +
        `grep=${String(grepLines).padStart(3)}L/${String(grepFiles).padStart(2)}f  ` +
        `ratio=${ratio.toFixed(2)}  ceiling=${ceiling}` +
        (capped ? "  [CAPPED — fixture too common]" : ""),
    );
  }

  console.log(
    `\nVerdict: ${allOK ? "PASS (no caller-count explosion)" : "FAIL (getCallers exceeds grep-truth ceiling — chunker symbol dedup regressed)"}`,
  );

  await db.close();
  return allOK;
}

async function main() {
  const platform = process.argv.includes("--platform");
  if (platform) {
    await platformProbe();
    await gracefulExit(0);
    return;
  }
  const ok = await callerCountGuard();
  await gracefulExit(ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
