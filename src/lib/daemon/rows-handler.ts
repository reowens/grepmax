/**
 * Daemon-side handlers for the `rows.*` read verbs.
 *
 * These serve the commands whose store work is a plain row select: `symbols`,
 * `project`, `extract`, `related`, `log`, `skeleton`. The daemon runs the query
 * against its already-warm VectorDB and returns the finished answer; the client
 * renders it and does anything tied to its own cwd, git, or filesystem.
 *
 * Every exported `run*` function is the *shared* implementation: the verb
 * handler calls it with the daemon's VectorDB, and the command's in-process
 * fallback calls the same function with a VectorDB it opened itself. That is
 * what makes the two paths byte-identical — there is only one implementation of
 * each query and each aggregation, and neither path can drift from the other.
 *
 * Two things are deliberately *not* raw row proxies:
 *
 * - `rows.symbols` returns the aggregated symbol table, not the 2000–10000 rows
 *   the select produces. The aggregation is pure, so moving it daemon-side
 *   cannot change the answer, and it turns a multi-megabyte JSON line into a
 *   list bounded by `--limit`.
 * - `rows.project` likewise returns the overview, not the rows. `project.ts`
 *   selects up to 200 000 rows including two symbol-array columns; on the
 *   platform project (266 753 chunks) proxying those rows would push hundreds
 *   of megabytes through the daemon's event loop for a summary that fits in a
 *   few kilobytes. The plan's own reasoning — "verbs at the library-function
 *   boundary, not a row proxy" — applies here more than anywhere.
 *
 * `rows.locate` *is* a row select, because its callers need the rows: extract
 * reads the file body at the returned line range, log feeds the paths to git,
 * related counts them. It is batched (an array of matchers, one response) so
 * `related`'s per-symbol loop costs one round trip instead of hundreds.
 */

import type { Table } from "@lancedb/lancedb";
import { isBuiltinCallee } from "../graph/callsites";
import { getStoredSkeleton } from "../skeleton/retriever";
import type { VectorDB } from "../store/vector-db";
import { toArr } from "../utils/arrow";
import type { DaemonResponse } from "../utils/daemon-client";
import {
  escapeSqlString,
  normalizePath,
  pathStartsWith,
} from "../utils/filter-builder";
import { resolveContainedPath } from "../utils/path-containment";
import { listProjects } from "../utils/project-registry";
import { withQueryTimeout } from "../utils/query-timeout";
import { buildScopeWhere, type ResolvedScope } from "../utils/scope-filter";
import { registerReadVerbs } from "./read-verbs";

// --- Shared deps ------------------------------------------------------------

/**
 * The slice of the daemon a read verb needs, supplied by `Daemon.storeReadDeps()`
 * and shared by the graph, rows, and vector handlers. Narrow on purpose, exactly
 * like `DaemonSearchDeps`: the handlers stay unit-testable with a bare VectorDB,
 * and the commands' in-process fallbacks satisfy the same interface.
 */
export interface StoreReadDeps {
  vectorDb: VectorDB | null;
  touchActivity?: () => void;
}

/**
 * Client-side counterpart to `readStoreDeps`: open a private VectorDB, run one
 * of the shared `run*` functions against it, and close it again.
 *
 * This is the *only* place a read command opens the store, and it is reached
 * only from a `withStoreRead` `inProcess` callback — i.e. only when nothing is
 * listening on the daemon socket.
 */
export async function withLocalStore<T>(
  lancedbDir: string,
  fn: (deps: StoreReadDeps) => Promise<T>,
): Promise<T> {
  const { VectorDB } = await import("../store/vector-db");
  const db = new VectorDB(lancedbDir);
  try {
    return await fn({ vectorDb: db });
  } finally {
    try {
      await db.close();
    } catch {}
  }
}

// --- Payload validation -----------------------------------------------------

/**
 * The scope shape read verbs put on the wire: the absolute prefixes a
 * `ResolvedScope` carries. The client resolves `--in`/`--exclude` (which needs
 * its own cwd and filesystem), the daemon re-validates every prefix against
 * `projectRoot` before it reaches a WHERE clause.
 */
export interface WireScope {
  pathPrefix: string;
  inPrefixes?: string[];
  excludePrefixes?: string[];
}

export function scopeToWire(scope: ResolvedScope): WireScope {
  return {
    pathPrefix: scope.pathPrefix,
    inPrefixes: scope.inPrefixes,
    excludePrefixes: scope.excludePrefixes,
  };
}

/** Thrown for a payload the daemon refuses; caught into an error response. */
export class ReadVerbError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ReadVerbError";
    this.hint = hint;
  }
}

/**
 * Validate `projectRoot` the way the `search` case does: it must name a project
 * the registry knows and has not marked `error`. An unregistered directory gets
 * the same "run: gmax add" answer `search` already gives it, rather than a
 * silently empty result from a scoped scan of the shared table.
 */
export function assertReadableProject(projectRoot: unknown): string {
  if (typeof projectRoot !== "string" || projectRoot === "") {
    throw new ReadVerbError("missing projectRoot");
  }
  const eligible = listProjects().filter((p) => p.status !== "error");
  if (!eligible.some((p) => p.root === projectRoot)) {
    throw new ReadVerbError(
      "project not registered",
      `run: gmax add ${projectRoot}`,
    );
  }
  return projectRoot;
}

/** Resolve one wire prefix against the project root, keeping its trailing slash. */
function containedPrefix(projectRoot: string, prefix: unknown): string {
  if (typeof prefix !== "string" || prefix === "") {
    throw new ReadVerbError("invalid path prefix");
  }
  const resolved = resolveContainedPath(projectRoot, prefix);
  // resolveContainedPath goes through path.resolve, which drops the trailing
  // separator that makes a prefix a directory boundary. Put it back only when
  // the caller had one — `symbols --path src` deliberately matches
  // `starts_with(path, '<root>/src')` with no trailing slash.
  return prefix.endsWith("/") ? `${resolved.replace(/\/$/, "")}/` : resolved;
}

/** Re-validate a wire scope and rebuild the `ResolvedScope` the queries use. */
export function resolveWireScope(
  projectRoot: string,
  wire: unknown,
): ResolvedScope {
  const raw = (wire ?? {}) as WireScope;
  const projectPrefix = projectRoot.endsWith("/")
    ? projectRoot
    : `${projectRoot}/`;
  return {
    pathPrefix:
      raw.pathPrefix === undefined
        ? projectPrefix
        : containedPrefix(projectRoot, raw.pathPrefix),
    inPrefixes: (raw.inPrefixes ?? []).map((p) =>
      containedPrefix(projectRoot, p),
    ),
    excludePrefixes: (raw.excludePrefixes ?? []).map((p) =>
      containedPrefix(projectRoot, p),
    ),
  };
}

/** Clamp an integer payload field into `[min, max]`, falling back on garbage. */
export function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n =
    typeof value === "number"
      ? Math.trunc(value)
      : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function tableOf(deps: StoreReadDeps): Promise<Table> {
  if (!deps.vectorDb) throw new ReadVerbError("daemon not ready");
  deps.touchActivity?.();
  return deps.vectorDb.ensureTable();
}

/** Wrap a handler body so a ReadVerbError becomes a clean error response. */
export async function asReadVerbResponse(
  fn: () => Promise<DaemonResponse>,
): Promise<DaemonResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ReadVerbError) {
      return err.hint
        ? { ok: false, error: err.message, hint: err.hint }
        : { ok: false, error: err.message };
    }
    throw err;
  }
}

// --- rows.symbols -----------------------------------------------------------

export interface SymbolEntry {
  symbol: string;
  count: number;
  path: string;
  /** 0-based start line of the first chunk that defines the symbol. */
  line: number;
  /** Chunk role of that first definition. MCP's `list_symbols` tags with it. */
  role: string;
  /** Whether that first definition is exported. Same reason. */
  exported: boolean;
}

export interface SymbolsRequest {
  projectRoot: string;
  /** Absolute prefix; matched with `starts_with`, trailing slash preserved. */
  pathPrefix?: string;
  pattern?: string;
  limit: number;
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v) => typeof v === "string");
  const arr = toArr(val);
  return Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : [];
}

/**
 * The `symbols` select plus its aggregation. Same query and same ordering as
 * before the split; only the process it runs in changed.
 *
 * `role` and `is_exported` were added to the select for MCP's `list_symbols`,
 * which has always tagged each row with them. They cost nothing (the same rows,
 * two more columns) and `gmax symbols` simply does not render them, so both
 * callers keep the output they had.
 */
export async function runSymbols(
  deps: StoreReadDeps,
  req: SymbolsRequest,
): Promise<SymbolEntry[]> {
  const table = await tableOf(deps);
  let query = table
    .query()
    .select(["defined_symbols", "path", "start_line", "role", "is_exported"])
    .where("array_length(defined_symbols) > 0")
    // Fetch more rows to ensure we have enough after filtering/aggregation
    .limit(req.pattern ? 10000 : Math.max(req.limit * 50, 2000));

  if (req.pathPrefix) {
    query = query.where(pathStartsWith(normalizePath(req.pathPrefix)));
  }

  const rows = await query.toArray();

  const map = new Map<string, SymbolEntry>();
  for (const row of rows) {
    const defs = toStringArray(
      (row as Record<string, unknown>).defined_symbols,
    );
    const rowPath = String((row as Record<string, unknown>).path || "");
    const line = Number((row as Record<string, unknown>).start_line || 0);
    const role = String((row as Record<string, unknown>).role || "");
    const exported = Boolean((row as Record<string, unknown>).is_exported);
    for (const sym of defs) {
      if (
        req.pattern &&
        !sym.toLowerCase().includes(req.pattern.toLowerCase())
      ) {
        continue;
      }
      const existing = map.get(sym);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(sym, {
          symbol: sym,
          count: 1,
          path: rowPath,
          line,
          role,
          exported,
        });
      }
    }
  }

  return Array.from(map.values())
    .sort((a, b) => {
      // Sort by count desc, then symbol asc
      if (b.count !== a.count) return b.count - a.count;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, req.limit);
}

export async function handleRowsSymbols(
  deps: StoreReadDeps,
  payload: Record<string, unknown>,
): Promise<DaemonResponse> {
  return asReadVerbResponse(async () => {
    const projectRoot = assertReadableProject(payload.projectRoot);
    const entries = await runSymbols(deps, {
      projectRoot,
      pathPrefix:
        payload.pathPrefix === undefined
          ? undefined
          : containedPrefix(projectRoot, payload.pathPrefix),
      pattern:
        typeof payload.pattern === "string" && payload.pattern
          ? payload.pattern
          : undefined,
      limit: clampInt(payload.limit, 20, 1, 10000),
    });
    return { ok: true, entries };
  });
}

// --- rows.project -----------------------------------------------------------

export interface ProjectOverview {
  chunks: number;
  files: number;
  /** Top 8 extensions by chunk count. */
  extEntries: Array<[string, number]>;
  /** Top 12 directory buckets by chunk count. */
  dirEntries: Array<[string, { files: number; chunks: number }]>;
  /** All roles, by chunk count desc. */
  roleEntries: Array<[string, number]>;
  /** Top 8 project-defined referenced symbols. */
  topSymbols: Array<[string, number]>;
  /** Up to 10 exported orchestration entry points. */
  entryPoints: Array<{ symbol: string; path: string }>;
}

/**
 * The `project` scan and its aggregation. Returns the finished overview rather
 * than the (up to 200 000) rows it was computed from — see the file header.
 */
export async function runProject(
  deps: StoreReadDeps,
  projectRoot: string,
): Promise<ProjectOverview> {
  const table = await tableOf(deps);
  const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  const rows = await table
    .query()
    .select([
      "path",
      "role",
      "is_exported",
      "complexity",
      "defined_symbols",
      "referenced_symbols",
    ])
    .where(pathStartsWith(prefix))
    .limit(200000)
    .toArray();

  const nodePath = await import("node:path");
  const files = new Set<string>();
  const extCounts = new Map<string, number>();
  const dirCounts = new Map<string, { files: Set<string>; chunks: number }>();
  const roleCounts = new Map<string, number>();
  const symbolRefs = new Map<string, number>();
  const definedInProject = new Set<string>();
  const entryPoints: Array<{ symbol: string; path: string }> = [];
  const seenEntryPoints = new Set<string>();

  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const p = String(r.path || "");
    const role = String(r.role || "IMPLEMENTATION");
    const exported = Boolean(r.is_exported);
    const complexity = Number(r.complexity || 0);
    const defs = toArr(r.defined_symbols);
    const refs = toArr(r.referenced_symbols);

    files.add(p);
    const ext = nodePath.extname(p).toLowerCase() || nodePath.basename(p);
    extCounts.set(ext, (extCounts.get(ext) || 0) + 1);

    const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
    const parts = rel.split("/");
    const dir =
      parts.length > 2
        ? `${parts.slice(0, 2).join("/")}/`
        : parts.length > 1
          ? `${parts[0]}/`
          : "(root)";
    if (!dirCounts.has(dir))
      dirCounts.set(dir, { files: new Set(), chunks: 0 });
    const dc = dirCounts.get(dir)!;
    dc.files.add(p);
    dc.chunks++;

    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    for (const d of defs) definedInProject.add(d);
    for (const ref of refs) symbolRefs.set(ref, (symbolRefs.get(ref) || 0) + 1);

    if (
      exported &&
      role === "ORCHESTRATION" &&
      complexity >= 5 &&
      defs.length > 0
    ) {
      const epKey = `${defs[0]}:${p}`;
      if (!seenEntryPoints.has(epKey)) {
        seenEntryPoints.add(epKey);
        entryPoints.push({
          symbol: defs[0],
          path: p.startsWith(prefix) ? p.slice(prefix.length) : p,
        });
      }
    }
  }

  return {
    chunks: rows.length,
    files: files.size,
    extEntries: Array.from(extCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
    // Human output shows 12, agent output shows the first 8 of the same order.
    dirEntries: Array.from(dirCounts.entries())
      .sort((a, b) => b[1].chunks - a[1].chunks)
      .slice(0, 12)
      .map(
        ([dir, data]) =>
          [dir, { files: data.files.size, chunks: data.chunks }] as [
            string,
            { files: number; chunks: number },
          ],
      ),
    roleEntries: Array.from(roleCounts.entries()).sort((a, b) => b[1] - a[1]),
    // Key symbols must be the project's own: raw referenced_symbols counts
    // are dominated by JS builtins (push, slice, map, …) which say nothing
    // about the codebase.
    topSymbols: Array.from(symbolRefs.entries())
      .filter(([s]) => definedInProject.has(s) && !isBuiltinCallee(s))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
    entryPoints: entryPoints.slice(0, 10),
  };
}

export async function handleRowsProject(
  deps: StoreReadDeps,
  payload: Record<string, unknown>,
): Promise<DaemonResponse> {
  return asReadVerbResponse(async () => {
    const projectRoot = assertReadableProject(payload.projectRoot);
    return { ok: true, overview: await runProject(deps, projectRoot) };
  });
}

// --- rows.locate ------------------------------------------------------------

/** The column set a row select may ask for. `content` and `vector` are not on it. */
const LOCATE_COLUMNS = new Set([
  "path",
  "start_line",
  "end_line",
  "role",
  "is_exported",
  "complexity",
  "defined_symbols",
  "referenced_symbols",
  "parent_symbol",
  "chunk_type",
  "id",
]);

const ARRAY_COLUMNS = new Set(["defined_symbols", "referenced_symbols"]);

/**
 * Upper bound on rows one matcher may return when the caller sets no limit.
 * `related`'s `content LIKE` scan deliberately has no `.limit()` — the limit
 * pushdown deadlocks on that shape (see query-timeout.ts) — and its JS loop
 * caps at `--limit` distinct paths, so a wire cap only bites on a query that
 * would already have been unreasonable to render.
 */
export const MAX_LOCATE_ROWS = 5000;

export type RowMatch =
  | { kind: "definedSymbol"; symbol: string }
  | { kind: "referencedSymbol"; symbol: string }
  | { kind: "path"; path: string }
  | { kind: "contentLike"; value: string };

export type LocatedRow = Record<string, unknown>;

export interface LocateRequest {
  projectRoot: string;
  scope: ResolvedScope;
  select: string[];
  matches: RowMatch[];
  /** Per-matcher row limit; omitted means "no LIMIT", capped at MAX_LOCATE_ROWS. */
  limit?: number;
  /** AND the resolved scope onto each matcher. Default true. */
  scoped?: boolean;
}

function matchCondition(match: RowMatch): { where: string; label: string } {
  switch (match.kind) {
    case "definedSymbol":
      return {
        where: `array_contains(defined_symbols, '${escapeSqlString(match.symbol)}')`,
        label: `defined_symbols ∋ ${match.symbol}`,
      };
    case "referencedSymbol":
      return {
        where: `array_contains(referenced_symbols, '${escapeSqlString(match.symbol)}')`,
        label: `referenced_symbols ∋ ${match.symbol}`,
      };
    case "path":
      return {
        where: `path = '${escapeSqlString(match.path)}'`,
        label: `path = ${match.path}`,
      };
    case "contentLike":
      return {
        where: `content LIKE '%${escapeSqlString(match.value)}%'`,
        label: `content LIKE %${match.value}% (related mentions)`,
      };
  }
}

/**
 * Normalize one Lance row to plain JSON. Arrow list columns do not survive
 * JSON.stringify as arrays, so they are converted here — in the *shared*
 * function, which means the in-process path sees exactly the same shape the
 * socket delivers.
 */
function normalizeRow(row: unknown, select: string[]): LocatedRow {
  const src = row as Record<string, unknown>;
  const out: LocatedRow = {};
  for (const col of select) {
    const value = src[col];
    if (ARRAY_COLUMNS.has(col)) out[col] = toArr(value);
    else if (col === "is_exported") out[col] = Boolean(value);
    else if (col === "start_line" || col === "end_line" || col === "complexity")
      out[col] = Number(value ?? 0);
    else out[col] = value === undefined || value === null ? "" : String(value);
  }
  return out;
}

/** Run a batch of row selects, one result array per matcher, order preserved. */
export async function runLocate(
  deps: StoreReadDeps,
  req: LocateRequest,
): Promise<LocatedRow[][]> {
  const table = await tableOf(deps);
  const scoped = req.scoped !== false;
  const pathScope = buildScopeWhere(req.scope);
  const results: LocatedRow[][] = [];

  for (const match of req.matches) {
    const { where, label } = matchCondition(match);
    let query = table
      .query()
      .select(req.select)
      .where(scoped ? `${where} AND ${pathScope}` : where);
    if (req.limit !== undefined) query = query.limit(req.limit);
    const rows = await withQueryTimeout(query.toArray(), label);
    results.push(
      rows
        .slice(0, req.limit ?? MAX_LOCATE_ROWS)
        .map((row) => normalizeRow(row, req.select)),
    );
  }
  return results;
}

export async function handleRowsLocate(
  deps: StoreReadDeps,
  payload: Record<string, unknown>,
): Promise<DaemonResponse> {
  return asReadVerbResponse(async () => {
    const projectRoot = assertReadableProject(payload.projectRoot);
    const scope = resolveWireScope(projectRoot, payload.scope);
    const select = Array.isArray(payload.select)
      ? payload.select.filter(
          (c): c is string => typeof c === "string" && LOCATE_COLUMNS.has(c),
        )
      : [];
    if (select.length === 0) throw new ReadVerbError("invalid select");
    const rawMatches = Array.isArray(payload.matches) ? payload.matches : [];
    if (rawMatches.length === 0) throw new ReadVerbError("missing matches");
    if (rawMatches.length > 2000) throw new ReadVerbError("too many matches");
    const matches: RowMatch[] = rawMatches.map((m) => {
      const match = m as Partial<RowMatch> & { kind?: string };
      if (
        (match.kind === "definedSymbol" || match.kind === "referencedSymbol") &&
        typeof (match as { symbol?: unknown }).symbol === "string"
      ) {
        return match as RowMatch;
      }
      if (
        match.kind === "path" &&
        typeof (match as { path?: unknown }).path === "string"
      ) {
        // A path matcher is an exact equality on an indexed absolute path;
        // containment keeps it inside the project the caller named.
        return {
          kind: "path",
          path: resolveContainedPath(
            projectRoot,
            (match as { path: string }).path,
          ),
        };
      }
      if (
        match.kind === "contentLike" &&
        typeof (match as { value?: unknown }).value === "string"
      ) {
        return match as RowMatch;
      }
      throw new ReadVerbError("invalid match");
    });

    const rows = await runLocate(deps, {
      projectRoot,
      scope,
      select,
      matches,
      limit:
        payload.limit === undefined
          ? undefined
          : clampInt(payload.limit, 10, 1, MAX_LOCATE_ROWS),
      scoped: payload.scoped !== false,
    });
    return { ok: true, rows };
  });
}

// --- rows.skeleton ----------------------------------------------------------

export interface SkeletonRequest {
  projectRoot: string;
  /** Absolute file path to fetch the stored skeleton for. */
  path?: string;
  /** Symbol to resolve to a defining file first (FTS lookup). */
  symbol?: string;
}

export interface SkeletonLookup {
  /** The file the skeleton belongs to, or null when a symbol resolved to nothing. */
  path: string | null;
  skeleton: string | null;
}

/**
 * `skeleton`'s two store reads: the FTS symbol → file lookup and the stored
 * per-file skeleton. Both are best-effort and return null rather than throwing,
 * exactly as `findFileBySymbol` and `getStoredSkeleton` always have.
 */
export async function runSkeleton(
  deps: StoreReadDeps,
  req: SkeletonRequest,
): Promise<SkeletonLookup> {
  if (!deps.vectorDb) throw new ReadVerbError("daemon not ready");
  deps.touchActivity?.();
  const db = deps.vectorDb;

  let filePath = req.path ?? null;
  if (!filePath && req.symbol) {
    filePath = await findFileBySymbol(db, req.symbol, req.projectRoot);
  }
  if (!filePath) return { path: null, skeleton: null };
  return { path: filePath, skeleton: await getStoredSkeleton(db, filePath) };
}

/** FTS lookup for the file that defines `symbol`; null when nothing matches. */
export async function findFileBySymbol(
  db: VectorDB,
  symbol: string,
  projectRoot: string,
): Promise<string | null> {
  try {
    const table = await db.ensureTable();
    const results = await table
      .search(symbol)
      .where(pathStartsWith(`${projectRoot}/`))
      .limit(10)
      .toArray();

    for (const result of results) {
      const defined = (result as Record<string, unknown>).defined_symbols;
      if (toArr(defined).includes(symbol)) {
        return String((result as Record<string, unknown>).path);
      }
    }
    if (results.length > 0) {
      return String((results[0] as Record<string, unknown>).path);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Client side of `rows.locate`: one round trip for a whole batch of matchers,
 * falling back to the same `runLocate` in-process when no daemon is listening.
 * Shared by extract, related, log, and context so the wire shape has exactly
 * one producer and one consumer.
 */
export async function readRows(opts: {
  name: string;
  projectRoot: string;
  lancedbDir: string;
  scope: ResolvedScope;
  select: string[];
  matches: RowMatch[];
  limit?: number;
  scoped?: boolean;
  timeoutMs?: number;
  /**
   * Extra fallback allowances, passed through to `withStoreRead`. Only MCP sets
   * these; a CLI command reports a live-daemon error rather than opening a
   * second reader. See `isOversizeError` in store-access.ts.
   */
  fallback?: {
    fallbackOnOversize?: boolean;
    extraFallback?: (error: unknown) => boolean;
  };
}): Promise<LocatedRow[][]> {
  if (opts.matches.length === 0) return [];
  const { sendDaemonCommand } = await import("../utils/daemon-client");
  const { withStoreRead } = await import("../utils/store-access");
  return withStoreRead<LocatedRow[][]>(opts.name, {
    daemon: () =>
      sendDaemonCommand(
        {
          cmd: "rows.locate",
          projectRoot: opts.projectRoot,
          scope: scopeToWire(opts.scope),
          select: opts.select,
          matches: opts.matches,
          limit: opts.limit,
          scoped: opts.scoped,
        },
        { timeoutMs: opts.timeoutMs ?? 60_000 },
      ),
    render: (resp) => (resp.rows ?? []) as LocatedRow[][],
    inProcess: () =>
      withLocalStore(opts.lancedbDir, (deps) =>
        runLocate(deps, {
          projectRoot: opts.projectRoot,
          scope: opts.scope,
          select: opts.select,
          matches: opts.matches,
          limit: opts.limit,
          scoped: opts.scoped,
        }),
      ),
    fallbackOnUnknownVerb: true,
    ...opts.fallback,
  });
}

export async function handleRowsSkeleton(
  deps: StoreReadDeps,
  payload: Record<string, unknown>,
): Promise<DaemonResponse> {
  return asReadVerbResponse(async () => {
    const projectRoot = assertReadableProject(payload.projectRoot);
    const target =
      typeof payload.path === "string" && payload.path
        ? resolveContainedPath(projectRoot, payload.path)
        : undefined;
    const symbol =
      typeof payload.symbol === "string" && payload.symbol
        ? payload.symbol
        : undefined;
    if (!target && !symbol) throw new ReadVerbError("missing path or symbol");
    const result = await runSkeleton(deps, {
      projectRoot,
      path: target,
      symbol,
    });
    return { ok: true, ...result };
  });
}

// --- Registration -----------------------------------------------------------

/**
 * Called from `Daemon.start()`, not at module scope: the registry's exact
 * contents are asserted on in tests/ipc-read-verbs.test.ts, and registering on
 * import would make it non-empty the moment ipc-handler is loaded.
 */
export function registerRowsVerbs(): void {
  registerReadVerbs({
    "rows.symbols": (payload, ctx) =>
      handleRowsSymbols(ctx.daemon.storeReadDeps(), payload),
    "rows.project": (payload, ctx) =>
      handleRowsProject(ctx.daemon.storeReadDeps(), payload),
    "rows.locate": (payload, ctx) =>
      handleRowsLocate(ctx.daemon.storeReadDeps(), payload),
    "rows.skeleton": (payload, ctx) =>
      handleRowsSkeleton(ctx.daemon.storeReadDeps(), payload),
  });
}
