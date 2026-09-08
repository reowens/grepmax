/**
 * Daemon-side handlers for the `graph.*` read verbs.
 *
 * The commands that used to open LanceDB themselves (`test`, `impact`, `trace`,
 * `peek`, `dead`, `audit`) now send one IPC line and render the answer. The work
 * they used to do between `ensureTable()` and the first `console.log` lives
 * here, so both paths run the *same* code:
 *
 *   - the daemon runs `runGraph*` against its warm `VectorDB`
 *   - a CLI with no daemon runs the identical `runGraph*` against a local one
 *
 * That is what makes the two paths byte-identical: the commands hold only
 * argument parsing and rendering, and every clamp lives inside the `runGraph*`
 * function rather than in one of the two callers.
 *
 * Results are finished answers, never raw rows. `graph.audit` reads up to 500k
 * chunks and returns a few dozen ranked lines; `graph.dead` reads the whole
 * caller set and returns a count plus three locations. Nothing here streams.
 *
 * Scope on the wire: the CLI resolves `--in`/`--exclude` locally (that needs its
 * cwd and the filesystem) and sends absolute prefixes. The daemon re-validates
 * every one with `resolveContainedPath` — exactly as the `search` case does —
 * and rebuilds the same `ResolvedScope` with `scopeFromPrefixes`, including the
 * single-`--in`-collapses-into-pathPrefix rule, so the WHERE clauses match.
 */

import * as path from "node:path";
import { languageFamilyForPath } from "../core/languages";
import { isBuiltinCallee } from "../graph/callsites";
import type { CallerTree, GraphNode } from "../graph/graph-builder";
import { GraphBuilder } from "../graph/graph-builder";
import type {
  DependentHit,
  DetailedDependentHit,
  SymbolFamilyMap,
  TestHit,
} from "../graph/impact";
import {
  findDependents,
  findDependentsDetailed,
  findTests,
  resolveTargetSymbols,
} from "../graph/impact";
import type { VectorDB } from "../store/vector-db";
import { toArr } from "../utils/arrow";
import type { DaemonResponse } from "../utils/daemon-client";
import { sendDaemonCommand } from "../utils/daemon-client";
import { escapeSqlString } from "../utils/filter-builder";
import { resolveContainedPath } from "../utils/path-containment";
import { getProject } from "../utils/project-registry";
import type { ResolvedScope } from "../utils/scope-filter";
import { buildScopeWhere } from "../utils/scope-filter";
import { withStoreRead } from "../utils/store-access";
import { fetchTestsForFooter } from "../utils/tests-footer";
import type { ReadVerbContext, ReadVerbHandler } from "./read-verbs";

/** Deps a graph verb needs from the daemon. Deliberately two fields: the warm
 *  store, and the idle-timer touch every served request owes the daemon. */
export interface GraphHandlerDeps {
  vectorDb: VectorDB | null;
  touchActivity: () => void;
}

// --- Wire shapes -----------------------------------------------------------

/** `[symbol, languageFamily]` pairs — a `SymbolFamilyMap` is a Map, and JSON
 *  has no Map. */
export type SymbolFamilyWire = Array<[string, string | null]>;

export interface GraphScopeWire {
  projectRoot: string;
  /** Every `--in` prefix, absolute, trailing-slash, *uncollapsed*. */
  inPrefixes?: string[];
  /** Every `--exclude` prefix, absolute, trailing-slash. */
  excludePrefixes?: string[];
}

export interface GraphResolveResult {
  symbols: string[];
  resolvedAsFile: boolean;
  symbolFamilies: SymbolFamilyWire | null;
}

export interface GraphDeadFacts {
  found: boolean;
  defPath: string;
  defLine: number;
  isExported: boolean;
  callerCount: number;
  topCallers: Array<{ file: string; line: number }>;
}

export interface GraphTraceResult {
  center: GraphNode | null;
  callerTree: CallerTree[];
  callees: GraphNode[];
  importers: string[];
}

export interface GraphPeekResult {
  /** Defining chunks (path + start line), pre-dedupe, as `peek` reads them for
   *  its multi-language guard and its "also defined in" note. */
  defChunks: Array<{ path: string; startLine: number }>;
  graph: {
    center: GraphNode | null;
    callers: GraphNode[];
    callees: GraphNode[];
  };
  /** First defining chunk's metadata, or null when the symbol has no chunk. */
  meta: { isExported: boolean; startLine: number; endLine: number } | null;
  /** Flattened multi-hop callers; null when depth <= 1 (peek uses graph.callers). */
  callerTree: CallerTree[] | null;
  /** null means the footer lookup timed out — same signal as in-process. */
  footerTests: TestHit[] | null;
}

const MAX_DEPTH = 3;
const AUDIT_ROW_LIMIT = 500_000;
const MAX_AUDIT_TOP = 1000;
const DEAD_TOP_CALLERS = 3;

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function withTrailingSlash(p: string): string {
  return p.endsWith("/") ? p : `${p}/`;
}

/**
 * Rebuild the CLI's `ResolvedScope` from the prefixes on the wire.
 *
 * Mirrors `resolveScope`: a single `--in` collapses into `pathPrefix` (which
 * keeps the WHERE clause simple), two or more stay in `inPrefixes` with
 * `pathPrefix` back at the project root.
 */
export function scopeFromPrefixes(
  projectRoot: string,
  inPrefixes: string[],
  excludePrefixes: string[],
): ResolvedScope {
  if (inPrefixes.length === 1) {
    return { pathPrefix: inPrefixes[0], inPrefixes: [], excludePrefixes };
  }
  return {
    pathPrefix: withTrailingSlash(projectRoot),
    inPrefixes,
    excludePrefixes,
  };
}

/**
 * The inverse, for the client: flatten a `ResolvedScope` back into the
 * uncollapsed prefix list the wire carries.
 */
export function inPrefixesOf(
  projectRoot: string,
  scope: ResolvedScope,
): string[] {
  if (scope.inPrefixes.length > 0) return scope.inPrefixes;
  return scope.pathPrefix === withTrailingSlash(projectRoot)
    ? []
    : [scope.pathPrefix];
}

/** Build the scope half of any graph verb payload. */
export function encodeScope(
  projectRoot: string,
  scope: ResolvedScope,
): GraphScopeWire {
  return {
    projectRoot,
    inPrefixes: inPrefixesOf(projectRoot, scope),
    excludePrefixes: scope.excludePrefixes,
  };
}

export function encodeSymbolFamilies(
  families: SymbolFamilyMap | undefined,
): SymbolFamilyWire | null {
  return families ? [...families.entries()] : null;
}

export function decodeSymbolFamilies(
  wire: unknown,
): SymbolFamilyMap | undefined {
  if (!Array.isArray(wire)) return undefined;
  const map: SymbolFamilyMap = new Map();
  for (const entry of wire) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    map.set(entry[0], typeof entry[1] === "string" ? entry[1] : null);
  }
  return map;
}

/**
 * True when a project is eligible for the daemon read path at all.
 *
 * The client consults this before sending: an unregistered directory has no
 * chunks in the shared table, and the daemon rejects it (fail closed). Falling
 * straight to the in-process path there keeps the old answer — "Symbol not
 * found" — instead of turning an empty result into a daemon error.
 */
export function isDaemonReadableProject(root: string): boolean {
  const project = getProject(root);
  return project !== undefined && project.status !== "error";
}

// --- Payload validation ----------------------------------------------------

interface DecodedScope {
  projectRoot: string;
  scope: ResolvedScope;
  /** True when any `--in` was given — selects the narrowed query root. */
  scoped: boolean;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`missing ${key}`);
  }
  return value;
}

function requirePrefixes(
  projectRoot: string,
  raw: unknown,
  key: string,
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`invalid ${key}`);
  return raw.map((prefix) => {
    if (typeof prefix !== "string") throw new Error(`invalid ${key}`);
    // Same containment rule the `search` case applies to its scope prefixes;
    // throwing here surfaces as an ordinary error response.
    return withTrailingSlash(resolveContainedPath(projectRoot, prefix));
  });
}

/**
 * Validate the scope half of a payload: the project must be registered and not
 * in `error` status, and every prefix must resolve inside it.
 */
function decodeScopePayload(payload: Record<string, unknown>): DecodedScope {
  const projectRoot = path.resolve(requireString(payload, "projectRoot"));
  if (!isDaemonReadableProject(projectRoot)) {
    throw new Error("project not registered");
  }
  const inPrefixes = requirePrefixes(
    projectRoot,
    payload.inPrefixes,
    "inPrefixes",
  );
  const excludePrefixes = requirePrefixes(
    projectRoot,
    payload.excludePrefixes,
    "excludePrefixes",
  );
  return {
    projectRoot,
    scope: scopeFromPrefixes(projectRoot, inPrefixes, excludePrefixes),
    scoped: inPrefixes.length > 0,
  };
}

function requireStore(deps: GraphHandlerDeps): VectorDB {
  if (!deps.vectorDb) throw new Error("daemon not ready");
  deps.touchActivity();
  return deps.vectorDb;
}

function requireSymbols(payload: Record<string, unknown>): string[] {
  const raw = payload.symbols;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error("missing symbols");
  return raw.map((s) => {
    if (typeof s !== "string") throw new Error("invalid symbols");
    return s;
  });
}

/**
 * The root `findTests`/`findDependents` query against. With any `--in` the CLI
 * narrows to the scope prefix; otherwise it is the project root.
 */
function queryRootFor(decoded: DecodedScope): string {
  return decoded.scoped
    ? decoded.scope.pathPrefix.replace(/\/$/, "")
    : decoded.projectRoot;
}

// --- Shared implementations (daemon and in-process run these) ---------------

export async function runGraphResolve(
  db: VectorDB,
  args: { target: string; projectRoot: string },
): Promise<GraphResolveResult> {
  const resolved = await resolveTargetSymbols(
    args.target,
    db,
    args.projectRoot,
  );
  return {
    symbols: resolved.symbols,
    resolvedAsFile: resolved.resolvedAsFile,
    symbolFamilies: encodeSymbolFamilies(resolved.symbolFamilies),
  };
}

export async function runGraphTests(
  db: VectorDB,
  args: {
    symbols: string[];
    queryRoot: string;
    depth: number;
    excludePrefixes: string[];
    families?: SymbolFamilyMap;
  },
): Promise<TestHit[]> {
  return findTests(
    args.symbols,
    db,
    args.queryRoot,
    clampInt(args.depth, 1, MAX_DEPTH, 1),
    args.excludePrefixes,
    args.families,
  );
}

export async function runGraphDependents(
  db: VectorDB,
  args: {
    symbols: string[];
    queryRoot: string;
    detailed: boolean;
    excludePaths?: string[];
    limit?: number;
    excludePrefixes: string[];
    families?: SymbolFamilyMap;
  },
): Promise<DependentHit[] | DetailedDependentHit[]> {
  const excludePaths =
    args.excludePaths && args.excludePaths.length > 0
      ? new Set(args.excludePaths)
      : undefined;
  // `undefined` keeps findDependents' own default of 10 — the shape the flat
  // (non-rollup) call has always used.
  const limit =
    typeof args.limit === "number"
      ? clampInt(args.limit, 1, 10_000, 10)
      : undefined;
  return args.detailed
    ? findDependentsDetailed(
        args.symbols,
        db,
        args.queryRoot,
        excludePaths,
        limit,
        args.excludePrefixes,
        args.families,
      )
    : findDependents(
        args.symbols,
        db,
        args.queryRoot,
        excludePaths,
        limit,
        args.excludePrefixes,
        args.families,
      );
}

export async function runGraphTrace(
  db: VectorDB,
  args: { symbol: string; hops: number; scope: ResolvedScope },
): Promise<GraphTraceResult> {
  const builder = new GraphBuilder(
    db,
    args.scope.pathPrefix,
    args.scope.excludePrefixes,
  );
  return builder.buildGraphMultiHop(
    args.symbol,
    clampInt(args.hops, 1, MAX_DEPTH, 1),
  );
}

export async function runGraphPeek(
  db: VectorDB,
  args: {
    symbol: string;
    depth: number;
    scope: ResolvedScope;
    includeTests: boolean;
  },
): Promise<GraphPeekResult> {
  const depth = clampInt(args.depth, 1, MAX_DEPTH, 1);
  const scopeWhere = (cond: string) => buildScopeWhere(args.scope, cond);
  const definedWhere = scopeWhere(
    `array_contains(defined_symbols, '${escapeSqlString(args.symbol)}')`,
  );

  const table = await db.ensureTable();
  const defRows = await table
    .query()
    .select(["path", "start_line"])
    .where(definedWhere)
    .limit(20)
    .toArray();
  const defChunks = defRows.map((row: unknown) => ({
    path: String((row as { path?: unknown }).path || ""),
    startLine: Number((row as { start_line?: unknown }).start_line || 0),
  }));

  const builder = new GraphBuilder(
    db,
    args.scope.pathPrefix,
    args.scope.excludePrefixes,
  );
  const graph = await builder.buildGraph(args.symbol);

  const metaRows = await table
    .query()
    .select(["is_exported", "start_line", "end_line"])
    .where(definedWhere)
    .limit(1)
    .toArray();
  const metaRow = metaRows[0] as
    | { is_exported?: unknown; start_line?: unknown; end_line?: unknown }
    | undefined;
  const meta = metaRow
    ? {
        isExported: Boolean(metaRow.is_exported),
        startLine: Number(metaRow.start_line || 0),
        endLine: Number(metaRow.end_line || 0),
      }
    : null;

  const callerTree =
    depth > 1
      ? (await builder.buildGraphMultiHop(args.symbol, depth)).callerTree
      : null;

  const footerTests = args.includeTests
    ? await fetchTestsForFooter(
        args.symbol,
        db,
        args.scope.pathPrefix,
        args.scope.excludePrefixes,
      )
    : null;

  return { defChunks, graph, meta, callerTree, footerTests };
}

export async function runGraphDead(
  db: VectorDB,
  args: { symbol: string; scope: ResolvedScope },
): Promise<GraphDeadFacts> {
  const table = await db.ensureTable();
  const defRows = await table
    .query()
    .select(["path", "start_line", "is_exported"])
    .where(
      buildScopeWhere(
        args.scope,
        `array_contains(defined_symbols, '${escapeSqlString(args.symbol)}')`,
      ),
    )
    .limit(1)
    .toArray();

  if (defRows.length === 0) {
    return {
      found: false,
      defPath: "",
      defLine: 0,
      isExported: false,
      callerCount: 0,
      topCallers: [],
    };
  }

  const defRow = defRows[0] as {
    path?: unknown;
    start_line?: unknown;
    is_exported?: unknown;
  };
  const defPath = String(defRow.path || "");
  const builder = new GraphBuilder(
    db,
    args.scope.pathPrefix,
    args.scope.excludePrefixes,
  );
  const callers: GraphNode[] = await builder.getCallers(
    args.symbol,
    languageFamilyForPath(defPath),
  );

  return {
    found: true,
    defPath,
    defLine: Number(defRow.start_line || 0),
    isExported: Boolean(defRow.is_exported),
    callerCount: callers.length,
    topCallers: callers
      .slice(0, DEAD_TOP_CALLERS)
      .map((c) => ({ file: c.file, line: c.line })),
  };
}

// --- audit aggregation -----------------------------------------------------

interface DefInfo {
  file: string;
  line: number;
  exported: boolean;
  complexity: number;
}

export interface GodNode {
  symbol: string;
  file: string;
  line: number;
  inboundFiles: number;
  totalRefs: number;
  /** Files defining this name. >1 means the attribution (file:line) is a
   * first-definition-wins guess and inbound counts merge all same-name
   * symbols. */
  defFiles: number;
}

export interface HubFile {
  file: string;
  dependents: number; // distinct external files depending on this file
  defines: number; // symbols defined here
  fanOut: number; // distinct in-project symbols this file references
}

export interface FileCycle {
  files: string[];
  edgeCount: number;
}

export interface DeadCandidate {
  symbol: string;
  file: string;
  line: number;
}

export interface AuditResult {
  scannedChunks: number;
  scannedFiles: number;
  godNodes: GodNode[];
  hubFiles: HubFile[];
  fileCycles: FileCycle[];
  deadCandidates: DeadCandidate[];
  deadTotal: number;
}

/** Minimal row shape the aggregator needs (a subset of the chunk record). */
export interface AuditRow {
  path: string;
  start_line: number;
  is_exported: boolean;
  defined_symbols: string[];
  referenced_symbols: string[];
}

// Names too generic to be useful as god-node signal (`id`, `el`, `fn`, …).
const MIN_GOD_NAME_LEN = 3;

function rel(p: string, prefix: string): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function findFileCycles(
  deps: Map<string, Set<string>>,
  prefix: string,
  top: number,
): FileCycle[] {
  const indexByFile = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let index = 0;

  const strongConnect = (file: string) => {
    indexByFile.set(file, index);
    lowlink.set(file, index);
    index++;
    stack.push(file);
    onStack.add(file);

    for (const dep of deps.get(file) ?? []) {
      if (!indexByFile.has(dep)) {
        strongConnect(dep);
        lowlink.set(
          file,
          Math.min(lowlink.get(file) ?? 0, lowlink.get(dep) ?? 0),
        );
      } else if (onStack.has(dep)) {
        lowlink.set(
          file,
          Math.min(lowlink.get(file) ?? 0, indexByFile.get(dep) ?? 0),
        );
      }
    }

    if (lowlink.get(file) !== indexByFile.get(file)) return;

    const component: string[] = [];
    while (stack.length > 0) {
      const dep = stack.pop()!;
      onStack.delete(dep);
      component.push(dep);
      if (dep === file) break;
    }
    if (component.length > 1) components.push(component);
  };

  const files = new Set<string>();
  for (const [file, targets] of deps) {
    files.add(file);
    for (const target of targets) files.add(target);
  }
  for (const file of [...files].sort()) {
    if (!indexByFile.has(file)) strongConnect(file);
  }

  return components
    .map((component) => {
      const set = new Set(component);
      let edgeCount = 0;
      for (const file of component) {
        for (const dep of deps.get(file) ?? []) {
          if (set.has(dep)) edgeCount++;
        }
      }
      return {
        files: component.map((f) => rel(f, prefix)).sort(),
        edgeCount,
      };
    })
    .sort(
      (a, b) =>
        b.files.length - a.files.length ||
        b.edgeCount - a.edgeCount ||
        a.files.join("\0").localeCompare(b.files.join("\0")),
    )
    .slice(0, top);
}

/**
 * Pure aggregation over chunk rows — no DB, no I/O. Builds the symbol→def map,
 * cross-file inbound edges, and per-file fan-in/out, then derives god nodes
 * (most depended-upon symbols), hub files (most depended-upon files), and
 * dead-code candidates (non-exported symbols with zero inbound references).
 * `top` caps each list; `deadTotal` reports the full pre-cap dead count.
 */
export function computeAudit(
  rows: AuditRow[],
  prefix: string,
  top: number,
): AuditResult {
  // First definition of a symbol wins (matches GraphBuilder semantics).
  const defs = new Map<string, DefInfo>();
  // Distinct files defining each name — name-based edges can't tell same-name
  // symbols apart, so multi-file definitions get flagged in the output.
  const defFileCounts = new Map<string, Set<string>>();
  // Distinct files that reference a symbol (cross-file inbound edges).
  const inboundFiles = new Map<string, Set<string>>();
  const inboundTotal = new Map<string, number>();
  // Per-file aggregates.
  const fileDefs = new Map<string, Set<string>>();
  const fileOutRefs = new Map<string, Set<string>>();
  const files = new Set<string>();

  for (const row of rows) {
    const file = String(row.path || "");
    const line = Number(row.start_line || 0);
    const exported = Boolean(row.is_exported);
    const defSyms = toArr(row.defined_symbols);
    const refSyms = toArr(row.referenced_symbols);
    files.add(file);

    for (const s of defSyms) {
      if (!defs.has(s)) {
        defs.set(s, { file, line, exported, complexity: 0 });
      }
      if (!defFileCounts.has(s)) defFileCounts.set(s, new Set());
      defFileCounts.get(s)!.add(file);
      if (!fileDefs.has(file)) fileDefs.set(file, new Set());
      fileDefs.get(file)!.add(s);
    }
    for (const s of refSyms) {
      if (!inboundFiles.has(s)) inboundFiles.set(s, new Set());
      inboundFiles.get(s)!.add(file);
      inboundTotal.set(s, (inboundTotal.get(s) || 0) + 1);
      if (!fileOutRefs.has(file)) fileOutRefs.set(file, new Set());
      fileOutRefs.get(file)!.add(s);
    }
  }

  // God nodes — in-project symbols by distinct external inbound files.
  const godNodes: GodNode[] = [];
  for (const [symbol, info] of defs) {
    if (symbol.length < MIN_GOD_NAME_LEN) continue;
    // Builtin method names (get, set, push, …) leak in via prototype/member
    // definitions and their inbound counts are meaningless name collisions.
    if (isBuiltinCallee(symbol)) continue;
    const refFiles = inboundFiles.get(symbol);
    if (!refFiles) continue;
    let external = 0;
    for (const f of refFiles) if (f !== info.file) external++;
    if (external === 0) continue;
    godNodes.push({
      symbol,
      file: rel(info.file, prefix),
      line: info.line,
      inboundFiles: external,
      totalRefs: inboundTotal.get(symbol) || 0,
      defFiles: defFileCounts.get(symbol)?.size ?? 1,
    });
  }
  godNodes.sort(
    (a, b) => b.inboundFiles - a.inboundFiles || b.totalRefs - a.totalRefs,
  );

  // Hub files — distinct external files depending on each file (a file G
  // depends on F if G references any symbol F defines).
  const hubFiles: HubFile[] = [];
  for (const [file, syms] of fileDefs) {
    const dependents = new Set<string>();
    for (const s of syms) {
      const refFiles = inboundFiles.get(s);
      if (!refFiles) continue;
      for (const f of refFiles) if (f !== file) dependents.add(f);
    }
    // Fan-out: distinct referenced symbols that are defined somewhere
    // in-project (external-library calls don't count as coupling).
    let fanOut = 0;
    const out = fileOutRefs.get(file);
    if (out) for (const s of out) if (defs.has(s)) fanOut++;
    hubFiles.push({
      file: rel(file, prefix),
      dependents: dependents.size,
      defines: syms.size,
      fanOut,
    });
  }
  hubFiles.sort((a, b) => b.dependents - a.dependents || b.defines - a.defines);

  const fileDeps = new Map<string, Set<string>>();
  for (const [file, refs] of fileOutRefs) {
    for (const s of refs) {
      if (isBuiltinCallee(s)) continue;
      const defFiles = defFileCounts.get(s);
      if (!defFiles || defFiles.size !== 1) continue;
      const [depFile] = defFiles;
      if (!depFile || depFile === file) continue;
      if (!fileDeps.has(file)) fileDeps.set(file, new Set());
      fileDeps.get(file)!.add(depFile);
    }
  }
  const fileCycles = findFileCycles(fileDeps, prefix, top);

  // Dead candidates — non-exported in-project symbols with zero inbound
  // references anywhere (including their own file).
  const deadAll: DeadCandidate[] = [];
  for (const [symbol, info] of defs) {
    if (info.exported) continue;
    if ((inboundTotal.get(symbol) || 0) > 0) continue;
    deadAll.push({ symbol, file: rel(info.file, prefix), line: info.line });
  }
  deadAll.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    scannedChunks: rows.length,
    scannedFiles: files.size,
    godNodes: godNodes.slice(0, top),
    hubFiles: hubFiles.filter((h) => h.dependents > 0).slice(0, top),
    fileCycles,
    deadCandidates: deadAll.slice(0, top),
    deadTotal: deadAll.length,
  };
}

/**
 * One pass over the scoped chunk rows, aggregated into the audit report.
 *
 * Returns null for an empty scope so the caller can print its own "no indexed
 * data" line. Never returns rows: the 500k-row read stays daemon-side.
 */
export async function runGraphAudit(
  db: VectorDB,
  args: { projectRoot: string; scope: ResolvedScope; top: number },
): Promise<AuditResult | null> {
  const top = clampInt(args.top, 1, MAX_AUDIT_TOP, 10);
  const prefix = withTrailingSlash(args.projectRoot);
  const table = await db.ensureTable();
  const rows = await table
    .query()
    .select([
      "path",
      "start_line",
      "defined_symbols",
      "referenced_symbols",
      "type_referenced_symbols",
      "is_exported",
    ])
    .where(buildScopeWhere(args.scope))
    .limit(AUDIT_ROW_LIMIT)
    .toArray();

  if (rows.length === 0) return null;

  return computeAudit(
    rows.map((r: unknown) => {
      const row = r as Record<string, unknown>;
      return {
        path: String(row.path || ""),
        start_line: Number(row.start_line || 0),
        is_exported: Boolean(row.is_exported),
        defined_symbols: toArr(row.defined_symbols),
        // Union call-position + type-position edges so god-node ranking and
        // dead-candidate detection see references made purely in type position.
        referenced_symbols: [
          ...new Set([
            ...toArr(row.referenced_symbols),
            ...toArr(row.type_referenced_symbols),
          ]),
        ],
      };
    }),
    prefix,
    top,
  );
}

// --- Verb handlers ---------------------------------------------------------

/**
 * Build the `graph.*` handler table over a deps supplier. `read-verbs.ts`
 * passes one that reads the live daemon's store; tests pass a temp VectorDB.
 */
export function createGraphVerbs(
  getDeps: (ctx: ReadVerbContext) => GraphHandlerDeps,
): Record<string, ReadVerbHandler> {
  const handlers: Record<
    string,
    (payload: Record<string, unknown>, db: VectorDB) => Promise<DaemonResponse>
  > = {
    "graph.resolve": async (payload, db) => {
      const { projectRoot } = decodeScopePayload(payload);
      const result = await runGraphResolve(db, {
        target: requireString(payload, "target"),
        projectRoot,
      });
      return { ok: true, ...result };
    },

    "graph.tests": async (payload, db) => {
      const decoded = decodeScopePayload(payload);
      const hits = await runGraphTests(db, {
        symbols: requireSymbols(payload),
        queryRoot: queryRootFor(decoded),
        depth: clampInt(payload.depth, 1, MAX_DEPTH, 1),
        excludePrefixes: decoded.scope.excludePrefixes,
        families: decodeSymbolFamilies(payload.families),
      });
      return { ok: true, hits };
    },

    "graph.dependents": async (payload, db) => {
      const decoded = decodeScopePayload(payload);
      const excludePaths = Array.isArray(payload.excludePaths)
        ? payload.excludePaths.filter((p): p is string => typeof p === "string")
        : undefined;
      const dependents = await runGraphDependents(db, {
        symbols: requireSymbols(payload),
        queryRoot: queryRootFor(decoded),
        detailed: payload.detailed === true,
        excludePaths,
        limit: typeof payload.limit === "number" ? payload.limit : undefined,
        excludePrefixes: decoded.scope.excludePrefixes,
        families: decodeSymbolFamilies(payload.families),
      });
      return { ok: true, dependents };
    },

    "graph.trace": async (payload, db) => {
      const decoded = decodeScopePayload(payload);
      const graph = await runGraphTrace(db, {
        symbol: requireString(payload, "target"),
        hops: clampInt(payload.hops, 1, MAX_DEPTH, 1),
        scope: decoded.scope,
      });
      return { ok: true, graph };
    },

    "graph.peek": async (payload, db) => {
      const decoded = decodeScopePayload(payload);
      const result = await runGraphPeek(db, {
        symbol: requireString(payload, "target"),
        depth: clampInt(payload.depth, 1, MAX_DEPTH, 1),
        scope: decoded.scope,
        includeTests: payload.includeTests === true,
      });
      return { ok: true, peek: result };
    },

    "graph.dead": async (payload, db) => {
      const decoded = decodeScopePayload(payload);
      const facts = await runGraphDead(db, {
        symbol: requireString(payload, "target"),
        scope: decoded.scope,
      });
      return { ok: true, dead: facts };
    },

    "graph.audit": async (payload, db) => {
      const decoded = decodeScopePayload(payload);
      const report = await runGraphAudit(db, {
        projectRoot: decoded.projectRoot,
        scope: decoded.scope,
        top: clampInt(payload.top, 1, MAX_AUDIT_TOP, 10),
      });
      return { ok: true, audit: report };
    },
  };

  const wired: Record<string, ReadVerbHandler> = {};
  for (const [name, run] of Object.entries(handlers)) {
    wired[name] = async (payload, ctx) =>
      run(payload, requireStore(getDeps(ctx)));
  }
  return wired;
}

// --- Client side -----------------------------------------------------------

/**
 * A graph verb can walk several hops over a large table; the 5 s default would
 * time out on a big project. Same budget `search` gives the daemon.
 */
export const GRAPH_VERB_TIMEOUT_MS = 60_000;

export interface GraphVerbCall<T> {
  projectRoot: string;
  scope: ResolvedScope;
  /** Verb-specific fields, merged over the scope fields. */
  payload?: Record<string, unknown>;
  /** Map the daemon's ok response to the caller's shape. */
  render: (resp: DaemonResponse) => T;
  /** Run the same `runGraph*` against a locally opened store. */
  inProcess: () => Promise<T>;
}

/**
 * Send one graph verb through the store-access policy.
 *
 * `fallbackOnUnknownVerb` is the one-release skew allowance: a daemon older
 * than this CLI answers `unknown command`, and the command still works. An
 * unregistered project skips the daemon outright — see isDaemonReadableProject.
 */
export function callGraphVerb<T>(
  verb: string,
  call: GraphVerbCall<T>,
): Promise<T> {
  return withStoreRead<T>(verb, {
    skipDaemon: !isDaemonReadableProject(call.projectRoot),
    fallbackOnUnknownVerb: true,
    daemon: () =>
      sendDaemonCommand(
        {
          cmd: verb,
          ...encodeScope(call.projectRoot, call.scope),
          ...call.payload,
        },
        { timeoutMs: GRAPH_VERB_TIMEOUT_MS },
      ),
    render: call.render,
    inProcess: call.inProcess,
  });
}
