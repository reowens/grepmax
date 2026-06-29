/**
 * Measure-first prototype for Graphify Phase 3 "surprising connections".
 *
 * It samples indexed code chunks, asks LanceDB for each chunk's nearest vector
 * neighbors, then filters out pairs that are already obvious:
 *   - same chunk / same file
 *   - same directory bucket
 *   - direct symbol-derived file dependency edge in either direction
 *   - tests, by default
 *   - eval/benchmark harnesses, by default
 *
 * The remaining high-similarity cross-directory pairs are candidate duplicate or
 * parallel logic. This is deliberately an eval harness, not product UI.
 *
 * Run:
 *   pnpm bench:surprises
 *   pnpm bench:surprises -- --sample 300 --neighbors 25 --top 30
 *   pnpm bench:surprises:json
 */

import * as path from "node:path";
import { isBuiltinCallee } from "./lib/graph/callsites";
import { VectorDB } from "./lib/store/vector-db";
import { toArr } from "./lib/utils/arrow";
import { gracefulExit } from "./lib/utils/exit";
import { pathStartsWith } from "./lib/utils/filter-builder";
import { ensureProjectPaths, findProjectRoot } from "./lib/utils/project-root";

type RawRow = Record<string, unknown>;

type ChunkRow = {
  id: string;
  path: string;
  relPath: string;
  startLine: number;
  endLine: number;
  role: string;
  content: string;
  vector: unknown;
  definedSymbols: string[];
  referencedSymbols: string[];
  typeReferencedSymbols: string[];
};

type SurprisePair = {
  similarity: number;
  distance: number;
  source: ChunkRow;
  target: ChunkRow;
};

type ScoreParts = {
  base: number;
  sameSymbolBoost: number;
  symbolShapeBoost: number;
  implementationBoost: number;
  supportBoost: number;
  tinyHelperPenalty: number;
  typeConstantPenalty: number;
  wrapperPenalty: number;
  score: number;
  reasons: string[];
};

type ScoredPair = SurprisePair & {
  scoreParts: ScoreParts;
};

type FilePairFinding = {
  fileA: string;
  fileB: string;
  pairCount: number;
  maxSimilarity: number;
  medianSimilarity: number;
  representative: ScoredPair;
  score: number;
  reasons: string[];
  topSimilarities: number[];
};

type Options = {
  root: string;
  sample: number;
  neighbors: number;
  top: number;
  dirDepth: number;
  minSimilarity: number;
  maxRows: number;
  includeTests: boolean;
  includeEval: boolean;
  json: boolean;
};

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".rb",
  ".kt",
  ".swift",
  ".scala",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
]);

const TEST_DIR_RE = /(^|\/)(__tests__|tests?|specs?|benchmark)(\/|$)/i;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const NATIVE_TEST_DIR_RE = /(^|\/)\w+Tests?(\/|$)/;
const NATIVE_TEST_FILE_RE = /Tests?\.(swift|kt|java)$/;

function isTestPath(filePath: string): boolean {
  return (
    TEST_DIR_RE.test(filePath) ||
    TEST_FILE_RE.test(filePath) ||
    NATIVE_TEST_DIR_RE.test(filePath) ||
    NATIVE_TEST_FILE_RE.test(filePath)
  );
}

function isEvalPath(filePath: string): boolean {
  return (
    /(^|\/)src\/eval[^/]*\.ts$/i.test(filePath) ||
    /(^|\/)(benchmarks?|experiments|scripts)(\/|$)/i.test(filePath)
  );
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
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

function parseOptions(): Options {
  return {
    root: path.resolve(argValue("--root") ?? process.cwd()),
    sample: intOpt("--sample", "GMAX_SURPRISE_SAMPLE", 160),
    neighbors: intOpt("--neighbors", "GMAX_SURPRISE_NEIGHBORS", 20),
    top: intOpt("--top", "GMAX_SURPRISE_TOP", 25),
    dirDepth: intOpt("--dir-depth", "GMAX_SURPRISE_DIR_DEPTH", 3),
    minSimilarity: floatOpt("--min-sim", "GMAX_SURPRISE_MIN_SIM", 0),
    maxRows: intOpt("--max-rows", "GMAX_SURPRISE_MAX_ROWS", 50_000),
    includeTests: hasFlag("--include-tests"),
    includeEval: hasFlag("--include-eval"),
    json: hasFlag("--json") || process.env.GMAX_EVAL_JSON === "1",
  };
}

function relPath(absPath: string, prefix: string): string {
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

function dirBucket(rel: string, depth: number): string {
  const dir = path.dirname(rel);
  if (dir === ".") return ".";
  return dir.split(path.sep).slice(0, depth).join(path.sep) || ".";
}

function isCodePath(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function vectorLength(vector: unknown): number {
  if (!vector) return 0;
  if (Array.isArray(vector)) return vector.length;
  if (ArrayBuffer.isView(vector)) {
    const view = vector as ArrayBufferView & { length?: number };
    return typeof view.length === "number" ? view.length : view.byteLength;
  }
  if (typeof (vector as { length?: unknown }).length === "number") {
    return Number((vector as { length: number }).length) || 0;
  }
  return 0;
}

function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rowKey(row: Pick<ChunkRow, "id" | "path" | "startLine">): string {
  return row.id || `${row.path}:${row.startLine}`;
}

function pairKey(a: ChunkRow, b: ChunkRow): string {
  return [rowKey(a), rowKey(b)].sort().join("\0");
}

function filePairKey(a: ChunkRow, b: ChunkRow): string {
  return [a.path, b.path].sort().join("\0");
}

function lineLabel(row: ChunkRow): string {
  const sym = row.definedSymbols[0] ? ` ${row.definedSymbols[0]}` : "";
  return `${row.relPath}:${row.startLine + 1}${sym}`;
}

function primarySymbol(row: ChunkRow): string {
  return row.definedSymbols.find((symbol) => !isBuiltinCallee(symbol)) ?? "";
}

function symbolTokens(symbol: string): Set<string> {
  const spaced = symbol
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return new Set(
    spaced.split(/[^a-z0-9]+/).filter((token) => token.length > 1),
  );
}

function exactSharedSymbols(a: ChunkRow, b: ChunkRow): string[] {
  const left = new Set(a.definedSymbols.filter((s) => !isBuiltinCallee(s)));
  return b.definedSymbols.filter((s) => left.has(s) && !isBuiltinCallee(s));
}

function symbolShapeSimilarity(a: ChunkRow, b: ChunkRow): number {
  const left = symbolTokens(primarySymbol(a));
  const right = symbolTokens(primarySymbol(b));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : overlap / union;
}

function lineCount(row: ChunkRow): number {
  return Math.max(1, row.endLine - row.startLine + 1);
}

function isTinyHelper(row: ChunkRow): boolean {
  return row.content.trim().length < 220 || lineCount(row) <= 8;
}

function isTypeLike(row: ChunkRow): boolean {
  return /^(export\s+)?(type|interface)\s+/m.test(row.content.trim());
}

function isConstantLike(row: ChunkRow): boolean {
  if (row.definedSymbols.length === 0) return false;
  return row.definedSymbols.every(
    (symbol) => /^[A-Z][A-Z0-9_]{2,}$/.test(symbol) || /_RE$/.test(symbol),
  );
}

function isImplementationLike(row: ChunkRow): boolean {
  if (isTypeLike(row) || isConstantLike(row)) return false;
  return row.content.trim().length >= 300 && lineCount(row) >= 8;
}

function isCommandLibraryPair(a: ChunkRow, b: ChunkRow): boolean {
  return (
    (a.relPath.startsWith("src/commands/") &&
      b.relPath.startsWith("src/lib/")) ||
    (b.relPath.startsWith("src/commands/") && a.relPath.startsWith("src/lib/"))
  );
}

function addReason(reasons: Set<string>, condition: boolean, reason: string) {
  if (condition) reasons.add(reason);
}

function scorePair(pair: SurprisePair, pairCount: number): ScoreParts {
  const sharedSymbols = exactSharedSymbols(pair.source, pair.target);
  const primaryMatch =
    primarySymbol(pair.source) !== "" &&
    primarySymbol(pair.source) === primarySymbol(pair.target);
  const symbolShape = symbolShapeSimilarity(pair.source, pair.target);
  const bothImplementation =
    isImplementationLike(pair.source) && isImplementationLike(pair.target);
  const anyImplementation =
    isImplementationLike(pair.source) || isImplementationLike(pair.target);
  const strongSymbol =
    primaryMatch || sharedSymbols.length > 0 || symbolShape >= 0.5;
  const sourceTiny = isTinyHelper(pair.source);
  const targetTiny = isTinyHelper(pair.target);
  const sourceTypeConstant =
    isTypeLike(pair.source) || isConstantLike(pair.source);
  const targetTypeConstant =
    isTypeLike(pair.target) || isConstantLike(pair.target);
  const commandWrapper = isCommandLibraryPair(pair.source, pair.target);

  const reasons = new Set<string>();
  addReason(reasons, primaryMatch || sharedSymbols.length > 0, "same-symbol");
  addReason(reasons, !primaryMatch && symbolShape >= 0.5, "similar-symbol");
  addReason(reasons, bothImplementation, "implementation");
  addReason(reasons, pairCount > 1, "multi-pair");
  addReason(reasons, sourceTiny || targetTiny, "tiny-helper");
  addReason(reasons, sourceTypeConstant || targetTypeConstant, "type-constant");
  addReason(reasons, commandWrapper, "command-wrapper");

  const sameSymbolBoost = primaryMatch
    ? 0.08
    : sharedSymbols.length > 0
      ? 0.05
      : 0;
  const symbolShapeBoost =
    !primaryMatch && sharedSymbols.length === 0 && symbolShape >= 0.5
      ? Math.min(0.05, symbolShape * 0.08)
      : 0;
  const implementationBoost = bothImplementation
    ? 0.04
    : anyImplementation
      ? 0.015
      : 0;
  const supportBoost = Math.min(0.06, Math.log2(pairCount + 1) * 0.018);
  const tinyHelperPenalty = strongSymbol
    ? 0
    : Math.min(0.06, (sourceTiny ? 0.03 : 0) + (targetTiny ? 0.03 : 0));
  const typeConstantPenalty = Math.min(
    0.1,
    (sourceTypeConstant ? 0.05 : 0) + (targetTypeConstant ? 0.05 : 0),
  );
  const wrapperPenalty = commandWrapper ? 0.06 : 0;
  const score =
    pair.similarity +
    sameSymbolBoost +
    symbolShapeBoost +
    implementationBoost +
    supportBoost -
    tinyHelperPenalty -
    typeConstantPenalty -
    wrapperPenalty;

  return {
    base: Number(pair.similarity.toFixed(3)),
    sameSymbolBoost: Number(sameSymbolBoost.toFixed(3)),
    symbolShapeBoost: Number(symbolShapeBoost.toFixed(3)),
    implementationBoost: Number(implementationBoost.toFixed(3)),
    supportBoost: Number(supportBoost.toFixed(3)),
    tinyHelperPenalty: Number(tinyHelperPenalty.toFixed(3)),
    typeConstantPenalty: Number(typeConstantPenalty.toFixed(3)),
    wrapperPenalty: Number(wrapperPenalty.toFixed(3)),
    score: Number(score.toFixed(3)),
    reasons: [...reasons].sort(),
  };
}

function toChunkRow(raw: RawRow, prefix: string): ChunkRow {
  const absPath = String(raw.path || "");
  return {
    id: String(raw.id || ""),
    path: absPath,
    relPath: relPath(absPath, prefix),
    startLine: Number(raw.start_line || 0),
    endLine: Number(raw.end_line || 0),
    role: String(raw.role || ""),
    content: String(raw.content || ""),
    vector: raw.vector,
    definedSymbols: toArr(raw.defined_symbols),
    referencedSymbols: toArr(raw.referenced_symbols),
    typeReferencedSymbols: toArr(raw.type_referenced_symbols),
  };
}

function similarityFromDistance(distance: number): number {
  return 1 / (1 + Math.max(0, distance));
}

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

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean =
    sorted.length === 0 ? 0 : sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    min: Number((sorted[0] ?? 0).toFixed(3)),
    p50: Number(quantile(sorted, 0.5).toFixed(3)),
    p90: Number(quantile(sorted, 0.9).toFixed(3)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
    mean: Number(mean.toFixed(3)),
  };
}

function buildFileEdges(rows: ChunkRow[]): Set<string> {
  const defFiles = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const symbol of row.definedSymbols) {
      if (!defFiles.has(symbol)) defFiles.set(symbol, new Set());
      defFiles.get(symbol)!.add(row.path);
    }
  }

  const edges = new Set<string>();
  for (const row of rows) {
    const refs = new Set([
      ...row.referencedSymbols,
      ...row.typeReferencedSymbols,
    ]);
    for (const symbol of refs) {
      if (isBuiltinCallee(symbol)) continue;
      const files = defFiles.get(symbol);
      if (!files || files.size !== 1) continue;
      const [targetFile] = files;
      if (!targetFile || targetFile === row.path) continue;
      edges.add(`${row.path}\0${targetFile}`);
    }
  }
  return edges;
}

function hasDirectFileEdge(
  edges: Set<string>,
  a: ChunkRow,
  b: ChunkRow,
): boolean {
  return edges.has(`${a.path}\0${b.path}`) || edges.has(`${b.path}\0${a.path}`);
}

function filterableCodeRow(
  row: ChunkRow,
  includeTests: boolean,
  includeEval: boolean,
): boolean {
  if (!row.path || !isCodePath(row.path)) return false;
  if (!includeTests && isTestPath(row.relPath)) return false;
  if (!includeEval && isEvalPath(row.relPath)) return false;
  if (vectorLength(row.vector) === 0) return false;
  if (row.content.trim().length < 80) return false;
  return row.definedSymbols.length > 0;
}

function buildFindings(pairs: SurprisePair[]): FilePairFinding[] {
  const groups = new Map<string, SurprisePair[]>();
  for (const pair of pairs) {
    const key = filePairKey(pair.source, pair.target);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(pair);
  }

  const findings: FilePairFinding[] = [];
  for (const group of groups.values()) {
    const scoredPairs: ScoredPair[] = group.map((pair) => ({
      ...pair,
      scoreParts: scorePair(pair, group.length),
    }));
    scoredPairs.sort(
      (a, b) =>
        b.scoreParts.score - a.scoreParts.score ||
        b.similarity - a.similarity ||
        a.distance - b.distance,
    );
    const representative = scoredPairs[0];
    const files = [representative.source, representative.target].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const similaritiesAsc = group
      .map((pair) => pair.similarity)
      .sort((a, b) => a - b);
    findings.push({
      fileA: files[0].relPath,
      fileB: files[1].relPath,
      pairCount: group.length,
      maxSimilarity: Number(
        (similaritiesAsc[similaritiesAsc.length - 1] ?? 0).toFixed(3),
      ),
      medianSimilarity: Number(quantile(similaritiesAsc, 0.5).toFixed(3)),
      representative,
      score: representative.scoreParts.score,
      reasons: representative.scoreParts.reasons,
      topSimilarities: [...similaritiesAsc]
        .reverse()
        .slice(0, 5)
        .map((value) => Number(value.toFixed(3))),
    });
  }

  return findings.sort(
    (a, b) =>
      b.score - a.score ||
      b.maxSimilarity - a.maxSimilarity ||
      b.pairCount - a.pairCount ||
      `${a.fileA}\0${a.fileB}`.localeCompare(`${b.fileA}\0${b.fileB}`),
  );
}

async function run() {
  const opts = parseOptions();
  const projectRoot = findProjectRoot(opts.root) ?? opts.root;
  const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  const paths = ensureProjectPaths(projectRoot);
  const vectorDb = new VectorDB(paths.lancedbDir);
  const table = await vectorDb.ensureTable();
  const log = opts.json ? console.error : console.log;

  const columns = [
    "id",
    "path",
    "start_line",
    "end_line",
    "defined_symbols",
    "referenced_symbols",
    "type_referenced_symbols",
    "role",
    "content",
    "vector",
  ];

  const rawRows = (await table
    .query()
    .select(columns)
    .where(pathStartsWith(prefix))
    .limit(opts.maxRows)
    .toArray()) as RawRow[];
  const rows = rawRows.map((row) => toChunkRow(row, prefix));
  const codeRows = rows.filter((row) =>
    filterableCodeRow(row, opts.includeTests, opts.includeEval),
  );
  const fileEdges = buildFileEdges(rows);
  const anchors = [...codeRows]
    .sort((a, b) => stableHash(rowKey(a)) - stableHash(rowKey(b)))
    .slice(0, opts.sample);

  log(
    `Surprising-connections prototype: ${anchors.length} sampled chunks from ${codeRows.length} code chunks (${rows.length} indexed rows)`,
  );

  const filters = {
    rawNeighbors: 0,
    sameChunk: 0,
    sameFile: 0,
    nonCode: 0,
    tests: 0,
    evalHarness: 0,
    sameDirBucket: 0,
    graphEdge: 0,
    belowThreshold: 0,
  };
  const pairs = new Map<string, SurprisePair>();

  for (const source of anchors) {
    const neighbors = (await table
      .vectorSearch(source.vector as number[])
      .select([...columns, "_distance"])
      .where(pathStartsWith(prefix))
      .limit(opts.neighbors + 8)
      .toArray()) as RawRow[];

    for (const rawTarget of neighbors) {
      filters.rawNeighbors++;
      const target = toChunkRow(rawTarget, prefix);
      if (rowKey(source) === rowKey(target)) {
        filters.sameChunk++;
        continue;
      }
      if (source.path === target.path) {
        filters.sameFile++;
        continue;
      }
      if (!isCodePath(target.path) || vectorLength(target.vector) === 0) {
        filters.nonCode++;
        continue;
      }
      if (!opts.includeTests && isTestPath(target.relPath)) {
        filters.tests++;
        continue;
      }
      if (!opts.includeEval && isEvalPath(target.relPath)) {
        filters.evalHarness++;
        continue;
      }
      if (
        dirBucket(source.relPath, opts.dirDepth) ===
        dirBucket(target.relPath, opts.dirDepth)
      ) {
        filters.sameDirBucket++;
        continue;
      }
      if (hasDirectFileEdge(fileEdges, source, target)) {
        filters.graphEdge++;
        continue;
      }

      const distance = Number(rawTarget._distance ?? 0);
      const similarity = similarityFromDistance(distance);
      if (similarity < opts.minSimilarity) {
        filters.belowThreshold++;
        continue;
      }

      const key = pairKey(source, target);
      const existing = pairs.get(key);
      if (!existing || similarity > existing.similarity) {
        pairs.set(key, { similarity, distance, source, target });
      }
    }
  }

  const acceptedPairs = [...pairs.values()].sort(
    (a, b) => a.distance - b.distance || b.similarity - a.similarity,
  );
  const findings = buildFindings(acceptedPairs);
  const topFindings = findings.slice(0, opts.top);
  const summary = {
    projectRoot,
    rows: rows.length,
    codeRows: codeRows.length,
    sampledAnchors: anchors.length,
    graphFileEdges: fileEdges.size,
    options: opts,
    filters,
    acceptedPairs: acceptedPairs.length,
    acceptedFilePairs: findings.length,
    similarity: stats(acceptedPairs.map((pair) => pair.similarity)),
    distance: stats(acceptedPairs.map((pair) => pair.distance)),
    actionabilityScore: stats(findings.map((finding) => finding.score)),
  };

  if (opts.json) {
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
    console.log(`  rows/code rows: ${rows.length}/${codeRows.length}`);
    console.log(`  sampled anchors: ${anchors.length}`);
    console.log(`  graph file edges: ${fileEdges.size}`);
    console.log(
      `  accepted pairs/file-pairs: ${acceptedPairs.length}/${findings.length}`,
    );
    console.log(
      `  similarity p50/p90/max: ${summary.similarity.p50}/${summary.similarity.p90}/${summary.similarity.max}`,
    );
    console.log(
      `  score p50/p90/max: ${summary.actionabilityScore.p50}/${summary.actionabilityScore.p90}/${summary.actionabilityScore.max}`,
    );
    console.log(
      `  filtered: same-file ${filters.sameFile}, same-dir ${filters.sameDirBucket}, graph-edge ${filters.graphEdge}, tests ${filters.tests}`,
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
