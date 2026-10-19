import { languageFamilyForPath } from "../core/languages";
import type { VectorRecord } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { toArr } from "../utils/arrow";
import {
  escapeSqlString,
  pathNotStartsWith,
  pathStartsWith,
} from "../utils/filter-builder";
import {
  QUERY_EXECUTION_OPTIONS,
  streamQueryRows,
} from "../utils/query-timeout";
import { isBuiltinCallee } from "./callsites";
import {
  bfsNeighbors,
  buildFileSubgraph,
  type FileSubgraph,
  findPath,
  type NeighborHit,
} from "./graph-traversal";

import {
  createTraceCollector,
  recordTraceCoverage,
  type TraceChunkSpan,
  type TraceCollector,
  type TraceEdgeEvidence,
  type TraceMetadata,
  type TraceReferenceColumn,
} from "./trace-evidence";

export type EdgeDirection = "callers" | "callees";

export interface GraphNode {
  symbol: string;
  file: string;
  line: number;
  role: string;
  calls: string[];
  calledBy: string[];
  complexity?: number;
  resolution?: "ambiguous-member";
  /**
   * Edge provenance for a caller node (how this chunk references the target):
   * Legacy tiers: `free` = referenced column, `member` = member column,
   * `type` = type column. These do not prove a call occurrence or target binding.
   * Undefined for center/callee nodes. Drives the confidence sort + tag.
   */
  edgeKind?: "free" | "member" | "type";
  /** Legacy confidence tier; neither value establishes a call or target binding. */
  confidence?: "EXTRACTED" | "INFERRED";
  evidence?: TraceEdgeEvidence | null;
}

export interface GraphDefinition {
  file: string;
  line: number;
  family: string | null;
  isExported?: boolean;
}

export interface CallerTree {
  node: GraphNode;
  callers: CallerTree[];
}

/** Sort key for the caller confidence tier: free call < member call < type ref. */
function edgeRank(node: GraphNode): number {
  switch (node.edgeKind) {
    case "free":
      return 0;
    case "member":
      return 1;
    case "type":
      return 2;
    default:
      return 3;
  }
}

interface CallerTraceContext {
  collector: TraceCollector;
  targetCandidate: TraceChunkSpan | null;
}

function chunkSpan(row: VectorRecord): TraceChunkSpan | null {
  if (!row.path || typeof row.start_line !== "number") return null;
  return {
    file: row.path,
    startLine: row.start_line,
    endLine: typeof row.end_line === "number" ? row.end_line : null,
  };
}

function referenceColumns(
  row: VectorRecord,
  symbol: string,
): TraceReferenceColumn[] | null {
  const columns: TraceReferenceColumn[] = [
    "referenced_symbols",
    "member_referenced_symbols",
    "type_referenced_symbols",
  ];
  if (columns.some((column) => row[column] == null)) return null;
  return columns.filter((column) => toArr(row[column]).includes(symbol));
}

function edgeEvidence(
  row: VectorRecord | null,
  spelling: string,
  targetCandidate: TraceChunkSpan | null,
  selectionBasis: TraceEdgeEvidence["selectionBasis"],
): TraceEdgeEvidence {
  return {
    referenceSpelling: spelling,
    referenceColumns: row ? referenceColumns(row, spelling) : null,
    sourceChunk: row ? chunkSpan(row) : null,
    targetCandidate,
    selectionBasis,
    callsite: null,
    bindingResolved: false,
  };
}

export class GraphBuilder {
  private pathPrefix: string | undefined;
  private excludePrefixes: string[];

  constructor(
    private db: VectorDB,
    pathPrefix?: string,
    excludePrefixes?: string[],
  ) {
    // Normalize to ensure trailing slash for LIKE queries
    this.pathPrefix = pathPrefix
      ? pathPrefix.endsWith("/")
        ? pathPrefix
        : `${pathPrefix}/`
      : undefined;
    this.excludePrefixes = (excludePrefixes ?? []).map((p) =>
      p.endsWith("/") ? p : `${p}/`,
    );
  }

  private scopeWhere(condition: string): string {
    let result = condition;
    if (this.pathPrefix) {
      result = `${result} AND ${pathStartsWith(this.pathPrefix)}`;
    }
    for (const ex of this.excludePrefixes) {
      result = `${result} AND ${pathNotStartsWith(ex)}`;
    }
    return result;
  }

  /**
   * Find all chunks that call the given symbol.
   *
   * `anchorFamily` (the language family of the symbol's definition) enables the
   * cross-language phantom-edge guard: the shared table matches a bare symbol
   * name across every language, so without it a `render` defined in one language
   * picks up callers that merely reference an unrelated `render` in another.
   */
  async getCallers(
    symbol: string,
    anchorFamily?: string | null,
    trace?: CallerTraceContext,
  ): Promise<GraphNode[]> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);

    // Find chunks that reference the symbol from a call position
    // (referenced_symbols) OR a type position (type_referenced_symbols). The
    // two are stored separately so type edges never inflate the call-edge count
    // used for ranking; navigation unions them.
    const rows = await table
      .query()
      .select([
        "path",
        "start_line",
        ...(trace ? ["end_line"] : []),
        "defined_symbols",
        "referenced_symbols",
        // member_/type_ are needed so each caller edge can be tagged free vs
        // member vs type (the confidence tier + builtin-member suppression).
        "member_referenced_symbols",
        "type_referenced_symbols",
        "role",
        "parent_symbol",
        "complexity",
      ])
      .where(
        this.scopeWhere(
          `(array_contains(referenced_symbols, '${escaped}') OR array_contains(type_referenced_symbols, '${escaped}'))`,
        ),
      )
      .limit(100)
      .toArray(QUERY_EXECUTION_OPTIONS);

    // Cross-language phantom-edge guard. When the anchor family is known, drop
    // callers from a *different known* family; callers we can't classify (unknown
    // extension) are kept so a real edge is never lost. No anchor → no filter.
    const guarded =
      anchorFamily == null
        ? rows
        : rows.filter((row) => {
            const fam = languageFamilyForPath(String((row as any).path ?? ""));
            return fam == null || fam === anchorFamily;
          });

    const nodes = guarded.map((row) => {
      const record = row as unknown as VectorRecord;
      const node = this.mapRowToNode(record, symbol, "caller");
      if (trace)
        node.evidence = edgeEvidence(
          record,
          symbol,
          trace.targetCandidate,
          "caller_chunk_attribution",
        );
      return node;
    });

    // Caller-side builtin-member suppression. A member call `x.T()` to a builtin
    // name T (`.get`/`.map`/`.forEach`) is almost always an unrelated stdlib
    // method, not a real caller of the project symbol T — mirrors the callee-side
    // guard in buildGraph. Only fires when T itself is a builtin name, so a normal
    // symbol that merely has member callers is untouched.
    const filtered = isBuiltinCallee(symbol)
      ? nodes.filter((n) => n.edgeKind !== "member")
      : nodes;

    recordTraceCoverage(trace?.collector, "caller_rows", {
      observed: rows.length,
      retained: filtered.length,
      filteredByPolicy: rows.length - filtered.length,
      limit: 100,
      limited: rows.length >= 100,
      reasons: [
        ...(rows.length >= 100 ? ["query_limit_exhaustion_unknown"] : []),
        ...(guarded.length < rows.length ? ["language_family_filter"] : []),
        ...(filtered.length < nodes.length
          ? ["builtin_member_suppression"]
          : []),
      ],
      omitted: { exact: rows.length >= 100 ? null : 0, lowerBound: 0 },
    });

    // Confidence sort: free calls (EXTRACTED) first, then member, then type,
    // preserving scan order within a tier (Array.sort is stable). Keeps the
    // trustworthy callers above the display caps (peek MAX_CALLERS, MCP limits)
    // so guesses don't read as facts.
    return filtered
      .map((n, i) => ({ n, i }))
      .sort((a, b) => edgeRank(a.n) - edgeRank(b.n) || a.i - b.i)
      .map(({ n }) => n);
  }

  /**
   * Find what the given symbol calls.
   * First finds the definition of the symbol, then returns its referenced_symbols.
   */
  async getCallees(symbol: string): Promise<string[]> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);

    // Find the definition of the symbol
    const rows = await table
      .query()
      .select([
        "path",
        "referenced_symbols",
        "member_referenced_symbols",
        "content",
      ])
      .where(this.scopeWhere(`array_contains(defined_symbols, '${escaped}')`))
      .limit(1)
      .toArray(QUERY_EXECUTION_OPTIONS);

    if (rows.length === 0) return [];

    const record = rows[0] as unknown as VectorRecord;
    const memberNames = toArr(record.member_referenced_symbols);
    const content = String(record.content ?? "");
    let localDefinitions: string[] = [];
    if (record.path && memberNames.some(isBuiltinCallee)) {
      const localRows = await table
        .query()
        .select(["defined_symbols"])
        .where(
          this.scopeWhere(`path = '${escapeSqlString(String(record.path))}'`),
        )
        .toArray(QUERY_EXECUTION_OPTIONS);
      localDefinitions = localRows.flatMap((row) =>
        toArr((row as any).defined_symbols),
      );
    }
    return toArr(record.referenced_symbols).filter((name) => {
      if (
        !isBuiltinCallee(name) ||
        !memberNames.includes(name) ||
        localDefinitions.includes(name)
      )
        return true;
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![\\w.$])${escapedName}\\s*\\(`).test(content);
    });
  }

  /**
   * Build a 1-hop graph around a symbol.
   */
  async buildGraph(
    symbol: string,
    trace?: TraceCollector,
  ): Promise<{
    center: GraphNode | null;
    callers: GraphNode[];
    callees: GraphNode[];
  }> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);

    // 1. Get Center (Definition)
    const centerRows = await table
      .query()
      .select([
        "path",
        "start_line",
        ...(trace ? ["end_line", "type_referenced_symbols"] : []),
        "defined_symbols",
        "referenced_symbols",
        "member_referenced_symbols",
        "content",
        "role",
        "parent_symbol",
        "complexity",
      ])
      .where(this.scopeWhere(`array_contains(defined_symbols, '${escaped}')`))
      .limit(1)
      .toArray(QUERY_EXECUTION_OPTIONS);

    const center =
      centerRows.length > 0
        ? this.mapRowToNode(
            centerRows[0] as unknown as VectorRecord,
            symbol,
            "center",
          )
        : null;

    const centerRecord = centerRows[0] as unknown as VectorRecord | undefined;
    if (trace) {
      trace.centerSelection = {
        referenceSpelling: symbol,
        targetCandidate: centerRecord ? chunkSpan(centerRecord) : null,
        selectionBasis: center ? "first_definition_match" : "no_candidate",
      };
      recordTraceCoverage(trace, "center_candidates", {
        observed: centerRows.length,
        retained: center ? 1 : 0,
        limit: 1,
        limited: centerRows.length >= 1,
        reasons: center ? ["first_match_exhaustion_unknown"] : [],
        omitted: { exact: center ? null : 0, lowerBound: 0 },
      });
    }

    // 2. Get Callers — anchored to the center definition's language family so a
    // bare name shared across languages doesn't pull in cross-language callers.
    const centerFamily = center ? languageFamilyForPath(center.file) : null;
    const callers = await this.getCallers(
      symbol,
      centerFamily,
      trace
        ? {
            collector: trace,
            targetCandidate: centerRecord ? chunkSpan(centerRecord) : null,
          }
        : undefined,
    );

    // 3. Get Callees — resolve each to a GraphNode with file:line
    const calleeNames = center ? center.calls.slice(0, 15) : [];
    const centerFile = center ? center.file : "";
    const calleeNodes: GraphNode[] = [];
    for (const name of calleeNames) {
      const esc = escapeSqlString(name);
      // Pull a few candidates (was .limit(1)) so a callee name defined in more
      // than one file can prefer the center's OWN file instead of an arbitrary
      // same-named definition in an unrelated module — the cheapest correct
      // disambiguation, and strictly better than the old first-row guess.
      const rows = await table
        .query()
        .where(this.scopeWhere(`array_contains(defined_symbols, '${esc}')`))
        .select([
          "path",
          "start_line",
          ...(trace ? ["end_line"] : []),
          "defined_symbols",
          "referenced_symbols",
          "role",
          "parent_symbol",
          "complexity",
        ])
        .limit(25)
        .toArray(QUERY_EXECUTION_OPTIONS);
      const memberNames = toArr(
        (centerRows[0] as any)?.member_referenced_symbols,
      );
      const content = String((centerRows[0] as any)?.content ?? "");
      const bareCall = new RegExp(
        `(?<![\\w.$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`,
      ).test(content);
      const selfDefinition = rows.find(
        (r) => String((r as any).path ?? "") === centerFile,
      );
      const receiverUnresolved =
        isBuiltinCallee(name) &&
        memberNames.includes(name) &&
        !bareCall &&
        !selfDefinition;
      const retainedCandidate = rows.length > 0 && !receiverUnresolved ? 1 : 0;
      recordTraceCoverage(trace, "callee_candidates", {
        observed: rows.length,
        retained: retainedCandidate,
        filteredByPolicy: rows.length - retainedCandidate,
        limit: 25,
        limited: rows.length >= 25,
        reasons: [
          ...(rows.length >= 25 ? ["query_limit_exhaustion_unknown"] : []),
          ...(rows.length > retainedCandidate
            ? [
                receiverUnresolved
                  ? "receiver_unresolved_policy"
                  : "candidate_selection_policy",
              ]
            : []),
        ],
        omitted: { exact: rows.length >= 25 ? null : 0, lowerBound: 0 },
      });
      if (receiverUnresolved) {
        calleeNodes.push({
          symbol: name,
          file: "",
          line: 0,
          role: "",
          calls: [],
          calledBy: [],
          resolution: "ambiguous-member",
          confidence: "INFERRED",
          ...(trace
            ? {
                evidence: edgeEvidence(
                  centerRecord ?? null,
                  name,
                  null,
                  "receiver_unresolved",
                ),
              }
            : {}),
        });
        continue;
      }
      if (rows.length > 0) {
        // Prefer-self-file, then same-language-family. Only fall back to the
        // first row when no candidate shares the center's file or family.
        const selfRow = rows.find(
          (r) => String((r as any).path ?? "") === centerFile,
        );
        const familyRow = centerFamily
          ? rows.find(
              (r) =>
                languageFamilyForPath(String((r as any).path ?? "")) ===
                centerFamily,
            )
          : undefined;
        const selected = (selfRow ??
          familyRow ??
          rows[0]) as unknown as VectorRecord;
        const node = this.mapRowToNode(selected, name, "center");
        if (trace)
          node.evidence = edgeEvidence(
            centerRecord ?? null,
            name,
            chunkSpan(selected),
            selfRow
              ? "same_file"
              : familyRow
                ? "same_language_family"
                : "first_candidate",
          );
        calleeNodes.push(node);
      } else if (!isBuiltinCallee(name)) {
        // Unresolved + a known builtin (.map/.get/forEach) → suppress the
        // phantom callee edge instead of emitting a "(not indexed)" stub.
        // Mirrors the display-layer guard (peek.ts: `c.file || !isBuiltinCallee`):
        // a project symbol that shadows a builtin name still resolves above and
        // is kept, so only genuine builtins are dropped.
        calleeNodes.push({
          symbol: name,
          file: "",
          line: 0,
          role: "",
          calls: [],
          calledBy: [],
          ...(trace
            ? {
                evidence: edgeEvidence(
                  centerRecord ?? null,
                  name,
                  null,
                  "no_candidate",
                ),
              }
            : {}),
        });
      }
    }

    const omittedSpellings = (center?.calls.length ?? 0) - calleeNames.length;
    recordTraceCoverage(trace, "callee_spellings", {
      observed: center?.calls.length ?? 0,
      retained: calleeNodes.length,
      filteredByPolicy: calleeNames.length - calleeNodes.length,
      limit: 15,
      limited: omittedSpellings > 0,
      reasons: [
        ...(omittedSpellings > 0 ? ["spelling_limit"] : []),
        ...(calleeNames.length > calleeNodes.length
          ? ["builtin_suppression"]
          : []),
      ],
      omitted: { exact: omittedSpellings, lowerBound: omittedSpellings },
    });

    return { center, callers, callees: calleeNodes };
  }

  async getImporters(
    symbol: string,
    trace?: TraceCollector,
  ): Promise<string[]> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);
    const rows = streamQueryRows(
      table
        .query()
        .select(["path"])
        .where(this.scopeWhere(`content LIKE '%import%${escaped}%'`)),
      `content LIKE %import%${symbol}% (importers)`,
    );

    const files = new Set<string>();
    let observed = 0;
    for await (const row of rows) {
      observed++;
      files.add(String((row as any).path || ""));
      if (files.size >= 100) break;
    }
    recordTraceCoverage(trace, "importer_files", {
      observed: files.size,
      retained: files.size,
      filteredByPolicy: 0,
      duplicateRows: observed - files.size,
      limit: 100,
      limited: files.size >= 100,
      reasons: [
        ...(files.size >= 100 ? ["stream_limit_exhaustion_unknown"] : []),
        ...(observed > files.size ? ["duplicate_file_policy"] : []),
      ],
      omitted: { exact: files.size >= 100 ? null : 0, lowerBound: 0 },
    });
    return Array.from(files);
  }

  async buildGraphMultiHop(
    symbol: string,
    depth: number,
    traceOptions?: { requestedDepth?: number | null },
  ): Promise<
    {
      center: GraphNode | null;
      callerTree: CallerTree[];
      callees: GraphNode[];
      importers: string[];
    } & Partial<TraceMetadata>
  > {
    const trace = traceOptions
      ? createTraceCollector(traceOptions.requestedDepth ?? null, depth)
      : undefined;
    const [graph, importers] = await Promise.all([
      this.buildGraph(symbol, trace),
      this.getImporters(symbol, trace),
    ]);
    const metadata = (): Partial<TraceMetadata> =>
      trace
        ? {
            evidenceVersion: 1,
            centerSelection: trace.centerSelection ?? {
              referenceSpelling: symbol,
              targetCandidate: null,
              selectionBasis: "unknown",
            },
            coverage: trace.coverage,
          }
        : {};

    if (depth <= 1 || !graph.center) {
      return {
        center: graph.center,
        callerTree: graph.callers.map((c) => ({ node: c, callers: [] })),
        callees: graph.callees,
        importers,
        ...metadata(),
      };
    }

    const visited = new Set<string>([symbol]);
    const callerTree = await this.expandCallers(
      graph.callers,
      depth - 1,
      visited,
      trace,
    );

    return {
      center: graph.center,
      callerTree,
      callees: graph.callees,
      importers,
      ...metadata(),
    };
  }

  private static readonly MAX_VISITED = 500;

  private async expandCallers(
    callers: GraphNode[],
    remainingDepth: number,
    visited: Set<string>,
    trace?: TraceCollector,
  ): Promise<CallerTree[]> {
    if (remainingDepth <= 0 || visited.size > GraphBuilder.MAX_VISITED) {
      const advisoryStop =
        remainingDepth > 0 && visited.size > GraphBuilder.MAX_VISITED;
      recordTraceCoverage(trace, "caller_expansion", {
        observed: callers.length,
        retained: 0,
        limit: GraphBuilder.MAX_VISITED,
        limited: advisoryStop,
        filteredByPolicy: advisoryStop ? 0 : callers.length,
        status: advisoryStop ? "unknown" : "complete",
        reasons: [
          advisoryStop ? "advisory_expansion_stop" : "requested_depth_boundary",
        ],
        omitted: { exact: advisoryStop ? null : 0, lowerBound: 0 },
      });
      return callers.map((c) => ({ node: c, callers: [] }));
    }

    const trees: CallerTree[] = [];
    for (const caller of callers) {
      if (visited.has(caller.symbol)) {
        recordTraceCoverage(trace, "caller_expansion", {
          observed: 1,
          retained: 0,
          filteredByPolicy: 1,
          limit: GraphBuilder.MAX_VISITED,
          reasons: ["name_visited"],
        });
        trees.push({ node: caller, callers: [] });
        continue;
      }
      visited.add(caller.symbol);
      recordTraceCoverage(trace, "caller_expansion", {
        observed: 1,
        retained: 1,
        limit: GraphBuilder.MAX_VISITED,
      });

      let subCallers: CallerTree[] = [];
      if (remainingDepth > 0) {
        const upstreamCallers = await this.getCallers(
          caller.symbol,
          languageFamilyForPath(caller.file),
          trace
            ? {
                collector: trace,
                targetCandidate: caller.evidence?.sourceChunk ?? null,
              }
            : undefined,
        );
        subCallers = await this.expandCallers(
          upstreamCallers,
          remainingDepth - 1,
          visited,
          trace,
        );
      }
      trees.push({ node: caller, callers: subCallers });
    }
    return trees;
  }

  // --- MCP graph primitives (Phase 7) -----------------------------------

  /** Symbols the given symbol references (outbound edges). */
  async calleesOf(symbol: string): Promise<string[]> {
    return this.getCallees(symbol);
  }

  /** Distinct symbols that reference the given symbol (inbound edges). */
  async callersOf(symbol: string): Promise<string[]> {
    const nodes = await this.getAnchoredCallers(symbol);
    const out: string[] = [];
    for (const n of nodes) {
      if (n.symbol && n.symbol !== "unknown" && !out.includes(n.symbol)) {
        out.push(n.symbol);
      }
    }
    return out;
  }

  private neighborFn(
    direction: EdgeDirection,
  ): (s: string) => Promise<string[]> {
    return direction === "callers"
      ? (s) => this.callersOf(s)
      : (s) => this.calleesOf(s);
  }

  /**
   * Symbols reachable from `symbol` along `direction` within `maxHops`, each
   * annotated with hop distance and resolved to a definition location when one
   * is indexed.
   */
  async getNeighbors(
    symbol: string,
    direction: EdgeDirection,
    maxHops: number,
  ): Promise<Array<NeighborHit & { file: string; line: number }>> {
    const hits = await bfsNeighbors(
      symbol,
      this.neighborFn(direction),
      maxHops,
    );
    // Resolve the origin once to anchor every neighbor's location lookup to the
    // same language family, so a shared name doesn't resolve to a foreign file.
    const origin = await this.resolveLocation(symbol);
    const anchorFamily = origin ? languageFamilyForPath(origin.file) : null;
    const out: Array<NeighborHit & { file: string; line: number }> = [];
    for (const h of hits) {
      const loc = await this.resolveLocation(h.symbol, anchorFamily);
      // Drop unresolved builtins (.map/.get/forEach) reached via callee edges —
      // same resolution-aware rule as buildGraph/peek. A neighbor that resolves
      // to an indexed definition is kept even if it shadows a builtin name.
      if (!loc && isBuiltinCallee(h.symbol)) continue;
      out.push({ ...h, file: loc?.file ?? "", line: loc?.line ?? 0 });
    }
    return out;
  }

  /** Shortest path `[from, …, to]` along `direction`, or null. */
  async findPaths(
    from: string,
    to: string,
    direction: EdgeDirection,
    maxHops = 6,
  ): Promise<string[] | null> {
    return findPath(from, to, this.neighborFn(direction), maxHops);
  }

  /**
   * Resolve a symbol to a defining chunk's file:line, if indexed. With
   * `anchorFamily` set, prefer the definition in that language family rather than
   * an arbitrary cross-language match (the shared table can hold the same name in
   * several languages); falls back to the first definition when none match.
   */
  async resolveLocation(
    symbol: string,
    anchorFamily?: string | null,
  ): Promise<{ file: string; line: number } | null> {
    const def = await this.resolveDefinition(symbol, anchorFamily);
    return def ? { file: def.file, line: def.line } : null;
  }

  /** Resolve a symbol to its defining chunk plus language family metadata. */
  async resolveDefinition(
    symbol: string,
    anchorFamily?: string | null,
  ): Promise<GraphDefinition | null> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);
    const rows = await table
      .query()
      .select(["path", "start_line", "is_exported"])
      .where(this.scopeWhere(`array_contains(defined_symbols, '${escaped}')`))
      // No anchor → keep the cheap single-row fetch. With one, pull a few
      // candidates so we can pick the same-family definition instead of guessing.
      .limit(anchorFamily ? 25 : 1)
      .toArray(QUERY_EXECUTION_OPTIONS);
    if (rows.length === 0) return null;
    let r = rows[0] as any;
    if (anchorFamily) {
      const match = rows.find(
        (row) =>
          languageFamilyForPath(String((row as any).path ?? "")) ===
          anchorFamily,
      );
      if (match) r = match as any;
    }
    const file = String(r.path || "");
    return {
      file,
      line: Number(r.start_line || 0),
      family: languageFamilyForPath(file),
      isExported: Boolean(r.is_exported),
    };
  }

  async getAnchoredCallers(symbol: string): Promise<GraphNode[]> {
    const def = await this.resolveDefinition(symbol);
    return this.getCallers(symbol, def?.family ?? null);
  }

  /**
   * Build the local dependency subgraph for a set of files: every symbol they
   * define, the edges among those symbols, and their outbound external deps.
   */
  async subgraphForFiles(files: string[]): Promise<FileSubgraph> {
    if (files.length === 0) {
      return { files: [], symbols: [], internalEdges: [], externalDeps: [] };
    }
    const table = await this.db.ensureTable();
    const orClause = files
      .map((f) => `path = '${escapeSqlString(f)}'`)
      .join(" OR ");
    const rows = await table
      .query()
      .select(["path", "defined_symbols", "referenced_symbols"])
      .where(this.scopeWhere(`(${orClause})`))
      .limit(100000)
      .toArray(QUERY_EXECUTION_OPTIONS);

    const toArray = (val: any): string[] => {
      if (val && typeof val.toArray === "function") return val.toArray();
      return Array.isArray(val) ? val : [];
    };

    return buildFileSubgraph(
      rows.map((r) => ({
        path: String((r as any).path || ""),
        defined_symbols: toArray((r as any).defined_symbols),
        referenced_symbols: toArray((r as any).referenced_symbols),
      })),
    );
  }

  private mapRowToNode(
    row: VectorRecord,
    targetSymbol: string,
    type: "center" | "caller",
  ): GraphNode {
    // Helper to convert Arrow Vector to array if needed
    const toArray = (val: any): string[] => {
      if (val && typeof val.toArray === "function") {
        return val.toArray();
      }
      return Array.isArray(val) ? val : [];
    };

    const definedSymbols = toArray(row.defined_symbols);
    const referencedSymbols = toArray(row.referenced_symbols);

    // If it's a caller, the symbol of interest is the one DOING the calling.
    // We try to find the defined symbol in this chunk that is responsible for the call.
    // If multiple are defined, we pick the first one or the parent_symbol.

    let symbol = definedSymbols[0] || row.parent_symbol || "unknown";
    if (type === "center") {
      symbol = targetSymbol;
    }

    // Classify HOW a caller references the target, for the confidence tier. Check
    // member first: member names are ALSO in referenced_symbols (additive column),
    // so a plain `referencedSymbols.includes` can't tell the two apart. Center and
    // callee nodes get no edgeKind (not applicable).
    let edgeKind: GraphNode["edgeKind"];
    let confidence: GraphNode["confidence"];
    if (type === "caller") {
      if (toArray(row.member_referenced_symbols).includes(targetSymbol)) {
        edgeKind = "member";
        confidence = "INFERRED";
      } else if (referencedSymbols.includes(targetSymbol)) {
        edgeKind = "free";
        confidence = "EXTRACTED";
      } else if (toArray(row.type_referenced_symbols).includes(targetSymbol)) {
        edgeKind = "type";
        confidence = "INFERRED";
      }
    }

    return {
      symbol,
      file: row.path,
      line: row.start_line,
      role: row.role || "IMPLEMENTATION",
      calls: referencedSymbols,
      calledBy: [], // To be filled if we do reverse lookup
      complexity: row.complexity,
      edgeKind,
      confidence,
    };
  }
}
