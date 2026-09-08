/**
 * Daemon-side handlers for the `vector.*` read verbs — the two commands whose
 * store work is a vector scan rather than a row select.
 *
 * Both ship the *analysed* answer, never the vectors:
 *
 * - `vector.similar` runs the source-chunk lookup, `configureAnnVectorQuery`,
 *   `table.vectorSearch`, and the self/threshold filter, and returns the ranked
 *   chunks. The 384-float source vector never crosses the socket.
 * - `vector.surprises` runs `analyzeSurprisingConnections` and returns the
 *   summary plus the findings the caller will actually print. The raw `pairs`
 *   array is dropped: nothing renders it, and it is the largest field by far.
 *
 * As in rows-handler.ts, each `run*` function is the single implementation both
 * the verb and the command's in-process fallback call, so the two paths cannot
 * produce different output.
 */

import {
  analyzeSurprisingConnections,
  DEFAULT_SURPRISE_OPTIONS,
  type FilePairFinding,
  MAX_SURPRISE_ROWS,
  type SurpriseAnalysisSummary,
} from "../analysis/surprising-connections";
import { configureAnnVectorQuery } from "../store/ann-config";
import { toArr } from "../utils/arrow";
import type { DaemonResponse } from "../utils/daemon-client";
import { escapeSqlString, pathStartsWith } from "../utils/filter-builder";
import { resolveContainedPath } from "../utils/path-containment";
import type { ResolvedScope } from "../utils/scope-filter";
import { buildScopeWhere } from "../utils/scope-filter";
import { registerReadVerbs } from "./read-verbs";
import {
  asReadVerbResponse,
  assertReadableProject,
  clampInt,
  ReadVerbError,
  resolveWireScope,
  type StoreReadDeps,
} from "./rows-handler";

// --- vector.similar ---------------------------------------------------------

export interface SimilarRequest {
  projectRoot: string;
  /** Absolute path when the target is a file; the source lookup keys on it. */
  absPath?: string;
  /** Symbol name when the target is not a file. */
  symbol?: string;
  scope: ResolvedScope;
  limit: number;
  threshold: number;
}

export interface SimilarRow {
  path: string;
  start_line: number;
  end_line: number;
  defined_symbols: string[];
  role: string;
  _distance: number;
}

export type SimilarResult =
  | { status: "not-found" }
  | { status: "no-vector" }
  | { status: "ok"; results: SimilarRow[] };

export async function runSimilar(
  deps: StoreReadDeps,
  req: SimilarRequest,
): Promise<SimilarResult> {
  if (!deps.vectorDb) throw new ReadVerbError("daemon not ready");
  deps.touchActivity?.();
  const table = await deps.vectorDb.ensureTable();

  const sourceSelect = ["vector", "path", "defined_symbols", "start_line"];
  const sourceRows = await table
    .query()
    .select(sourceSelect)
    .where(
      req.absPath !== undefined
        ? `path = '${escapeSqlString(req.absPath)}'`
        : `array_contains(defined_symbols, '${escapeSqlString(req.symbol ?? "")}') AND ${pathStartsWith(`${req.projectRoot}/`)}`,
    )
    .limit(1)
    .toArray();

  if (sourceRows.length === 0) return { status: "not-found" };

  const source = sourceRows[0] as Record<string, unknown>;
  const sourceVector = source.vector as ArrayLike<number> | undefined;
  const sourcePath = String(source.path || "");
  if (!sourceVector || sourceVector.length === 0)
    return { status: "no-vector" };

  const pathScope = buildScopeWhere(req.scope);
  const results = await configureAnnVectorQuery(
    table.vectorSearch(sourceVector as number[]),
  )
    .select([
      "path",
      "start_line",
      "end_line",
      "defined_symbols",
      "role",
      "content",
      "_distance",
    ])
    .where(pathScope)
    .limit(req.limit + 5) // fetch extra to account for self-filtering
    .toArray();

  // Filter out self and apply threshold
  const filtered = results.filter((raw) => {
    const r = raw as Record<string, unknown>;
    if (r.path === sourcePath && r.start_line === source.start_line)
      return false;
    if (req.threshold > 0) {
      // LanceDB returns L2 distance; convert to similarity
      const sim = 1 / (1 + (Number(r._distance) || 0));
      if (sim < req.threshold) return false;
    }
    return true;
  });

  // `content` is selected (keeping the query identical) but never rendered, so
  // it is dropped here rather than shipped.
  return {
    status: "ok",
    results: filtered.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        path: String(r.path ?? ""),
        start_line: Number(r.start_line ?? 0),
        end_line: Number(r.end_line ?? 0),
        defined_symbols: toArr(r.defined_symbols),
        role: String(r.role ?? ""),
        _distance: Number(r._distance ?? 0),
      };
    }),
  };
}

export async function handleVectorSimilar(
  deps: StoreReadDeps,
  payload: Record<string, unknown>,
): Promise<DaemonResponse> {
  return asReadVerbResponse(async () => {
    const projectRoot = assertReadableProject(payload.projectRoot);
    const scope = resolveWireScope(projectRoot, payload.scope);
    const absPath =
      typeof payload.absPath === "string" && payload.absPath
        ? resolveContainedPath(projectRoot, payload.absPath)
        : undefined;
    const symbol =
      typeof payload.symbol === "string" && payload.symbol
        ? payload.symbol
        : undefined;
    if (!absPath && !symbol) throw new ReadVerbError("missing target");
    const result = await runSimilar(deps, {
      projectRoot,
      absPath,
      symbol,
      scope,
      limit: clampInt(payload.limit, 5, 1, 25),
      threshold:
        typeof payload.threshold === "number" &&
        Number.isFinite(payload.threshold)
          ? payload.threshold
          : 0,
    });
    return { ok: true, ...result };
  });
}

// --- vector.surprises -------------------------------------------------------

export interface SurprisesRequest {
  projectRoot: string;
  options: {
    sample: number;
    neighbors: number;
    dirDepth: number;
    minSimilarity: number;
    maxRows: number;
    includeTests: boolean;
    includeEval: boolean;
    in?: string[];
    exclude?: string[];
  };
  /** How many grouped findings the caller will print; the rest are dropped. */
  top: number;
}

export interface SurprisesResult {
  summary: SurpriseAnalysisSummary;
  findings: FilePairFinding[];
}

export async function runSurprises(
  deps: StoreReadDeps,
  req: SurprisesRequest,
): Promise<SurprisesResult> {
  if (!deps.vectorDb) throw new ReadVerbError("daemon not ready");
  deps.touchActivity?.();
  const table = await deps.vectorDb.ensureTable();
  const result = await analyzeSurprisingConnections(
    table,
    req.projectRoot,
    req.options,
  );
  // Both formatters use only `summary` and `findings.slice(0, top)`, plus
  // `findings.length === 0`. Trimming to `top` here preserves both and keeps
  // `pairs` (the bulk of the object) off the wire entirely.
  return {
    summary: result.summary,
    findings: result.findings.slice(0, req.top),
  };
}

export async function handleVectorSurprises(
  deps: StoreReadDeps,
  payload: Record<string, unknown>,
): Promise<DaemonResponse> {
  return asReadVerbResponse(async () => {
    const projectRoot = assertReadableProject(payload.projectRoot);
    const raw = (payload.options ?? {}) as Record<string, unknown>;
    const toPrefixList = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value) || value.length === 0) return undefined;
      // Validated here rather than trusted: these reach resolveScope, which
      // builds the WHERE clause the scan runs under.
      return value.map((v) => resolveContainedPath(projectRoot, String(v)));
    };
    const result = await runSurprises(deps, {
      projectRoot,
      options: {
        sample: clampInt(
          raw.sample,
          DEFAULT_SURPRISE_OPTIONS.sample,
          1,
          10_000,
        ),
        neighbors: clampInt(
          raw.neighbors,
          DEFAULT_SURPRISE_OPTIONS.neighbors,
          1,
          200,
        ),
        dirDepth: clampInt(
          raw.dirDepth,
          DEFAULT_SURPRISE_OPTIONS.dirDepth,
          1,
          20,
        ),
        minSimilarity:
          typeof raw.minSimilarity === "number" &&
          Number.isFinite(raw.minSimilarity) &&
          raw.minSimilarity >= 0
            ? raw.minSimilarity
            : DEFAULT_SURPRISE_OPTIONS.minSimilarity,
        maxRows: clampInt(
          raw.maxRows,
          DEFAULT_SURPRISE_OPTIONS.maxRows,
          1,
          MAX_SURPRISE_ROWS,
        ),
        includeTests: Boolean(raw.includeTests),
        includeEval: Boolean(raw.includeEval),
        in: toPrefixList(raw.in),
        exclude: toPrefixList(raw.exclude),
      },
      top: clampInt(payload.top, 20, 1, 100),
    });
    return { ok: true, ...result };
  });
}

// --- Registration -----------------------------------------------------------

/** Called from `Daemon.start()`; see registerRowsVerbs for why not at import. */
export function registerVectorVerbs(): void {
  registerReadVerbs({
    "vector.similar": (payload, ctx) =>
      handleVectorSimilar(ctx.daemon.storeReadDeps(), payload),
    "vector.surprises": (payload, ctx) =>
      handleVectorSurprises(ctx.daemon.storeReadDeps(), payload),
  });
}
