import * as path from "node:path";
import { isBuiltinCallee } from "../graph/callsites";
import { configureAnnVectorQuery } from "../store/ann-config";
import { toArr } from "../utils/arrow";
import { escapeSqlString } from "../utils/filter-builder";
import { buildScopeWhere, resolveScope } from "../utils/scope-filter";

type RawRow = Record<string, unknown>;

export type ChunkRow = {
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

export type SurprisePair = {
  similarity: number;
  distance: number;
  source: ChunkRow;
  target: ChunkRow;
};

export type ScoreParts = {
  base: number;
  sameSymbolBoost: number;
  symbolShapeBoost: number;
  implementationBoost: number;
  supportBoost: number;
  tinyHelperPenalty: number;
  typeConstantPenalty: number;
  wrapperPenalty: number;
  genericSymbolPenalty: number;
  score: number;
  reasons: string[];
};

export type ScoredPair = SurprisePair & {
  scoreParts: ScoreParts;
};

export type FilePairFinding = {
  fileA: string;
  fileB: string;
  pairCount: number;
  maxSimilarity: number;
  medianSimilarity: number;
  representative: ScoredPair;
  examples?: ScoredPair[];
  score: number;
  reasons: string[];
  topSimilarities: number[];
};

export type SurpriseAnalysisOptions = {
  sample: number;
  neighbors: number;
  dirDepth: number;
  minSimilarity: number;
  maxRows: number;
  includeTests: boolean;
  includeEval: boolean;
  in?: string | string[];
  exclude?: string | string[];
};

export type SurpriseAnalysisSummary = {
  projectRoot: string;
  rows: number;
  codeRows: number;
  sampledAnchors: number;
  graphFileEdges: number;
  options: SurpriseAnalysisOptions;
  filters: {
    rawNeighbors: number;
    sameChunk: number;
    sameFile: number;
    nonCode: number;
    weakCode: number;
    tests: number;
    evalHarness: number;
    sameDirBucket: number;
    graphEdge: number;
    belowThreshold: number;
  };
  acceptedPairs: number;
  acceptedFilePairs: number;
  similarity: ReturnType<typeof stats>;
  distance: ReturnType<typeof stats>;
  actionabilityScore: ReturnType<typeof stats>;
};

export type SurpriseAnalysisResult = {
  summary: SurpriseAnalysisSummary;
  pairs: SurprisePair[];
  findings: FilePairFinding[];
};

export const DEFAULT_SURPRISE_OPTIONS: SurpriseAnalysisOptions = {
  sample: 160,
  neighbors: 20,
  dirDepth: 3,
  minSimilarity: 0,
  maxRows: 50_000,
  includeTests: false,
  includeEval: false,
};

export const MAX_SURPRISE_ROWS = 100_000;

/**
 * Columns a pair row carries: the scan's metadata plus `content`, which the
 * weak-code filter and the scorer read. `vector` is not here — only sampled
 * anchors need one, and they fetch it by id (see `hydrateRows`).
 */
export const SURPRISE_COLUMNS = [
  "id",
  "path",
  "start_line",
  "end_line",
  "defined_symbols",
  "referenced_symbols",
  "type_referenced_symbols",
  "role",
  "content",
];

const MIN_CODE_CONTENT_LENGTH = 80;

/**
 * The row scan reads up to MAX_SURPRISE_ROWS rows. Selecting `content` and
 * `vector` there held every chunk body and embedding in memory for an answer
 * that needs ~160 vectors. It now selects metadata plus two bounds on the
 * weak-code test (`content.trim().length >= 80`), computed in the store:
 *
 * - `content_min_len` trims a *superset* of JS whitespace (Unicode White_Space
 *   plus U+FEFF) and counts code points, so it never exceeds the JS length —
 *   at or above the threshold, the row passes.
 * - `content_max_len` trims a *subset* (ASCII whitespace) and counts UTF-8
 *   bytes, so it is never below the JS length — under the threshold, it fails.
 *
 * Anything between the two (non-ASCII text or whitespace near the threshold)
 * fetches its content by id and takes the exact JS test, so `codeRows` and the
 * anchor sample are unchanged. Backslashes are literal in DataFusion strings.
 */
const CONTENT_MIN_LEN_EXPR =
  "char_length(regexp_replace(content, '^[\\s\\x{FEFF}]+|[\\s\\x{FEFF}]+$', '', 'g'))";
const CONTENT_MAX_LEN_EXPR =
  "octet_length(regexp_replace(content, '^[\\t\\n\\x0B\\f\\r ]+|[\\t\\n\\x0B\\f\\r ]+$', '', 'g'))";

const SCAN_SELECT: Record<string, string> = {
  id: "id",
  path: "path",
  start_line: "start_line",
  end_line: "end_line",
  defined_symbols: "defined_symbols",
  referenced_symbols: "referenced_symbols",
  type_referenced_symbols: "type_referenced_symbols",
  role: "role",
  content_min_len: CONTENT_MIN_LEN_EXPR,
  content_max_len: CONTENT_MAX_LEN_EXPR,
};

/** Ids per `id IN (...)` hydration query. */
const HYDRATE_BATCH = 200;

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

export function normalizeSurpriseOptions(
  opts: Partial<SurpriseAnalysisOptions> = {},
): SurpriseAnalysisOptions {
  return {
    ...DEFAULT_SURPRISE_OPTIONS,
    ...opts,
    sample: Math.max(
      1,
      Math.floor(opts.sample ?? DEFAULT_SURPRISE_OPTIONS.sample),
    ),
    neighbors: Math.max(
      1,
      Math.floor(opts.neighbors ?? DEFAULT_SURPRISE_OPTIONS.neighbors),
    ),
    dirDepth: Math.max(
      1,
      Math.floor(opts.dirDepth ?? DEFAULT_SURPRISE_OPTIONS.dirDepth),
    ),
    minSimilarity: Math.max(
      0,
      opts.minSimilarity ?? DEFAULT_SURPRISE_OPTIONS.minSimilarity,
    ),
    maxRows: Math.max(
      1,
      Math.min(
        MAX_SURPRISE_ROWS,
        Math.floor(opts.maxRows ?? DEFAULT_SURPRISE_OPTIONS.maxRows),
      ),
    ),
    includeTests: opts.includeTests ?? DEFAULT_SURPRISE_OPTIONS.includeTests,
    includeEval: opts.includeEval ?? DEFAULT_SURPRISE_OPTIONS.includeEval,
  };
}

export function isTestPath(filePath: string): boolean {
  return (
    TEST_DIR_RE.test(filePath) ||
    TEST_FILE_RE.test(filePath) ||
    NATIVE_TEST_DIR_RE.test(filePath) ||
    NATIVE_TEST_FILE_RE.test(filePath)
  );
}

export function isEvalPath(filePath: string): boolean {
  return (
    /(^|\/)src\/eval[^/]*\.ts$/i.test(filePath) ||
    /(^|\/)(benchmarks?|experiments|scripts)(\/|$)/i.test(filePath)
  );
}

export function relPath(absPath: string, prefix: string): string {
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

export function lineLabel(row: ChunkRow): string {
  const sym = row.definedSymbols[0] ? ` ${row.definedSymbols[0]}` : "";
  return `${row.relPath}:${row.startLine + 1}${sym}`;
}

export function directoryBucket(rel: string, depth: number): string {
  const dir = path.dirname(rel);
  if (dir === ".") return ".";
  return dir.split(path.sep).slice(0, depth).join(path.sep) || ".";
}

export function findingBucketLabel(
  finding: Pick<FilePairFinding, "fileA" | "fileB">,
  dirDepth: number,
): string {
  return `${directoryBucket(finding.fileA, dirDepth)}<->${directoryBucket(
    finding.fileB,
    dirDepth,
  )}`;
}

export function findingExamples(
  finding: Pick<FilePairFinding, "representative" | "examples">,
  limit = 2,
): ScoredPair[] {
  const examples = finding.examples?.length
    ? finding.examples
    : [finding.representative];
  return examples.slice(0, limit);
}

export function formatPenaltySummary(parts: ScoreParts): string {
  const entries = [
    ["tiny", parts.tinyHelperPenalty],
    ["type", parts.typeConstantPenalty],
    ["wrapper", parts.wrapperPenalty],
    ["generic", parts.genericSymbolPenalty],
  ].filter(([, value]) => Number(value) > 0);
  return entries.length === 0
    ? "none"
    : entries.map(([name, value]) => `${name}:${value}`).join(",");
}

export function skeletonHint(
  finding: Pick<FilePairFinding, "fileA" | "fileB">,
): string {
  return `gmax skeleton ${JSON.stringify(finding.fileA)} | gmax skeleton ${JSON.stringify(
    finding.fileB,
  )}`;
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

const GENERIC_SYMBOLS = new Set([
  "constructor",
  "context",
  "data",
  "default",
  "fmt",
  "get",
  "height",
  "kind",
  "main",
  "new",
  "options",
  "rel",
  "relpath",
  "resolve",
  "root",
  "run",
  "set",
  "style",
  "styles",
  "toarray",
  "tostringarray",
  "type",
  "types",
  "value",
  "values",
  "width",
]);

function isGenericSymbol(symbol: string): boolean {
  const normalized = symbol.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.length <= 1 || GENERIC_SYMBOLS.has(normalized);
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

export function scorePair(pair: SurprisePair, pairCount: number): ScoreParts {
  const sharedSymbols = exactSharedSymbols(pair.source, pair.target);
  const sourcePrimary = primarySymbol(pair.source);
  const targetPrimary = primarySymbol(pair.target);
  const primaryMatch = sourcePrimary !== "" && sourcePrimary === targetPrimary;
  const genericExactSymbol =
    (primaryMatch && isGenericSymbol(sourcePrimary)) ||
    sharedSymbols.some((symbol) => isGenericSymbol(symbol));
  const symbolShape = symbolShapeSimilarity(pair.source, pair.target);
  const bothImplementation =
    isImplementationLike(pair.source) && isImplementationLike(pair.target);
  const anyImplementation =
    isImplementationLike(pair.source) || isImplementationLike(pair.target);
  const strongSymbol =
    !genericExactSymbol &&
    (primaryMatch || sharedSymbols.length > 0 || symbolShape >= 0.5);
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
  addReason(reasons, genericExactSymbol, "generic-symbol");

  const sameSymbolBoost = genericExactSymbol
    ? 0
    : primaryMatch
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
  const tinyHelperBase = (sourceTiny ? 0.06 : 0) + (targetTiny ? 0.06 : 0);
  const tinyHelperPenalty = strongSymbol
    ? Math.min(0.04, tinyHelperBase / 2)
    : Math.min(0.12, tinyHelperBase);
  const typeConstantPenalty = Math.min(
    0.18,
    (sourceTypeConstant ? 0.09 : 0) + (targetTypeConstant ? 0.09 : 0),
  );
  const wrapperPenalty = commandWrapper ? 0.12 : 0;
  const genericSymbolPenalty = genericExactSymbol ? 0.08 : 0;
  const score =
    pair.similarity +
    sameSymbolBoost +
    symbolShapeBoost +
    implementationBoost +
    supportBoost -
    tinyHelperPenalty -
    typeConstantPenalty -
    wrapperPenalty -
    genericSymbolPenalty;

  return {
    base: Number(pair.similarity.toFixed(3)),
    sameSymbolBoost: Number(sameSymbolBoost.toFixed(3)),
    symbolShapeBoost: Number(symbolShapeBoost.toFixed(3)),
    implementationBoost: Number(implementationBoost.toFixed(3)),
    supportBoost: Number(supportBoost.toFixed(3)),
    tinyHelperPenalty: Number(tinyHelperPenalty.toFixed(3)),
    typeConstantPenalty: Number(typeConstantPenalty.toFixed(3)),
    wrapperPenalty: Number(wrapperPenalty.toFixed(3)),
    genericSymbolPenalty: Number(genericSymbolPenalty.toFixed(3)),
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

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedAsc[base + 1];
  return next !== undefined
    ? sortedAsc[base] + rest * (next - sortedAsc[base])
    : sortedAsc[base];
}

export function stats(values: number[]) {
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

function hasDirectFileEdge(edges: Set<string>, a: ChunkRow, b: ChunkRow) {
  return edges.has(`${a.path}\0${b.path}`) || edges.has(`${b.path}\0${a.path}`);
}

/** The anchor filter minus its content and vector tests (see below). */
function filterableCodeMeta(
  row: ChunkRow,
  opts: SurpriseAnalysisOptions,
): boolean {
  if (!row.path || !isCodePath(row.path)) return false;
  if (!opts.includeTests && isTestPath(row.relPath)) return false;
  if (!opts.includeEval && isEvalPath(row.relPath)) return false;
  return row.definedSymbols.length > 0;
}

function hasCodeContent(content: string): boolean {
  return content.trim().length >= MIN_CODE_CONTENT_LENGTH;
}

/**
 * The weak-code verdict from the scan alone: true/false when the store-side
 * bounds decide it, null when the row needs its content fetched. A row that
 * already carries `content` (a caller-supplied table) is decided exactly.
 */
function contentVerdict(raw: RawRow): boolean | null {
  if (typeof raw.content === "string") return hasCodeContent(raw.content);
  const min = Number(raw.content_min_len);
  const max = Number(raw.content_max_len);
  if (Number.isFinite(min) && min >= MIN_CODE_CONTENT_LENGTH) return true;
  if (Number.isFinite(max) && max < MIN_CODE_CONTENT_LENGTH) return false;
  return null;
}

/**
 * Fetch `columns` for the given ids, keyed by id. The scope clause is ANDed
 * on so a hydration can never reach outside the scan that produced the ids.
 */
async function hydrateRows(
  table: any,
  where: string,
  ids: string[],
  columns: string[],
): Promise<Map<string, RawRow>> {
  const out = new Map<string, RawRow>();
  for (let i = 0; i < ids.length; i += HYDRATE_BATCH) {
    const batch = ids.slice(i, i + HYDRATE_BATCH);
    const list = batch.map((id) => `'${escapeSqlString(id)}'`).join(", ");
    const rows = (await table
      .query()
      .select(["id", ...columns])
      .where(`(${where}) AND id IN (${list})`)
      .limit(batch.length)
      .toArray()) as RawRow[];
    for (const row of rows) out.set(String(row.id || ""), row);
  }
  return out;
}

/** Pair rows carry no vector: nothing downstream reads one, and findings cross the socket. */
function withoutVector(row: ChunkRow): ChunkRow {
  return row.vector === undefined ? row : { ...row, vector: undefined };
}

export function buildFindings(pairs: SurprisePair[]): FilePairFinding[] {
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
      examples: scoredPairs.slice(0, 3),
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

export async function analyzeSurprisingConnections(
  table: any,
  projectRoot: string,
  partialOptions: Partial<SurpriseAnalysisOptions> = {},
): Promise<SurpriseAnalysisResult> {
  const opts = normalizeSurpriseOptions(partialOptions);
  const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  const scope = resolveScope({
    projectRoot,
    in: opts.in,
    exclude: opts.exclude,
  });
  const where = buildScopeWhere(scope);
  const rawRows = (await table
    .query()
    .select(SCAN_SELECT)
    .where(where)
    .limit(opts.maxRows)
    .toArray()) as RawRow[];
  const rows = rawRows.map((row) => toChunkRow(row, prefix));
  const fileEdges = buildFileEdges(rows);

  // Weak-code test: decided from the scan's bounds where possible, otherwise
  // from content fetched for just the undecided rows.
  const candidates: Array<{ row: ChunkRow; verdict: boolean | null }> = [];
  for (let i = 0; i < rows.length; i++) {
    if (!filterableCodeMeta(rows[i], opts)) continue;
    candidates.push({ row: rows[i], verdict: contentVerdict(rawRows[i]) });
  }
  const undecidedContent = await hydrateRows(
    table,
    where,
    candidates
      .filter((c) => c.verdict === null && c.row.id)
      .map((c) => c.row.id),
    ["content"],
  );
  const codeRows = candidates
    .filter(({ row, verdict }) => {
      if (verdict !== null) return verdict;
      const hydrated = undecidedContent.get(row.id);
      return hydrated ? hasCodeContent(String(hydrated.content || "")) : false;
    })
    .map(({ row }) => row);

  // Anchors are the first `sample` code rows in hash order, and only they need
  // content and a vector. Fetch those a page at a time, skipping any row that
  // comes back without a vector (the column is non-nullable, so this is
  // defensive) just as the old whole-scan filter did.
  const ordered = [...codeRows].sort(
    (a, b) => stableHash(rowKey(a)) - stableHash(rowKey(b)),
  );
  const anchors: ChunkRow[] = [];
  for (
    let i = 0;
    i < ordered.length && anchors.length < opts.sample;
    i += opts.sample
  ) {
    const page = ordered.slice(i, i + opts.sample);
    const fetched = await hydrateRows(
      table,
      where,
      page
        .filter((row) => row.id && vectorLength(row.vector) === 0)
        .map((row) => row.id),
      ["content", "vector"],
    );
    for (const row of page) {
      if (anchors.length >= opts.sample) break;
      const extra = fetched.get(row.id);
      const anchor: ChunkRow = extra
        ? { ...row, content: String(extra.content || ""), vector: extra.vector }
        : row;
      if (vectorLength(anchor.vector) === 0) continue;
      anchors.push(anchor);
    }
  }
  const filters = {
    rawNeighbors: 0,
    sameChunk: 0,
    sameFile: 0,
    nonCode: 0,
    weakCode: 0,
    tests: 0,
    evalHarness: 0,
    sameDirBucket: 0,
    graphEdge: 0,
    belowThreshold: 0,
  };
  const pairs = new Map<string, SurprisePair>();

  for (const anchor of anchors) {
    const source = withoutVector(anchor);
    const neighbors = (await configureAnnVectorQuery(
      table.vectorSearch(anchor.vector as number[]),
    )
      .select([...SURPRISE_COLUMNS, "_distance"])
      .where(where)
      .limit(opts.neighbors + 8)
      .toArray()) as RawRow[];

    for (const rawTarget of neighbors) {
      filters.rawNeighbors++;
      const target = withoutVector(toChunkRow(rawTarget, prefix));
      if (rowKey(source) === rowKey(target)) {
        filters.sameChunk++;
        continue;
      }
      if (source.path === target.path) {
        filters.sameFile++;
        continue;
      }
      // A vector-search hit has a vector by construction, and `vector` is not
      // selected, so only the path decides "non-code" here.
      if (!isCodePath(target.path)) {
        filters.nonCode++;
        continue;
      }
      if (
        target.content.trim().length < 80 ||
        target.definedSymbols.length === 0
      ) {
        filters.weakCode++;
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
        directoryBucket(source.relPath, opts.dirDepth) ===
        directoryBucket(target.relPath, opts.dirDepth)
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
  return {
    summary: {
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
    },
    pairs: acceptedPairs,
    findings,
  };
}
