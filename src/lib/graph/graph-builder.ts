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
  QueryTimeoutError,
  streamQueryRows,
  withQueryTimeout,
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

import { GraphWorkBudget, type GraphWorkSummary } from "./work-budget";

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

  /** Every traversal query reserves its row/query allowance before native work.
   * A saturated adjacency window means unknown remaining rows, never exhaustion. */
  private async queryRows(
    query: {
      limit(n: number): {
        toArray(options: { timeoutMs: number }): Promise<any[]>;
      };
    },
    limit: number,
    work?: GraphWorkBudget,
    adjacency = false,
  ): Promise<any[]> {
    if (!work) return query.limit(limit).toArray(QUERY_EXECUTION_OPTIONS);
    if (work.stopped()) return [];
    const rowLimit = Math.min(limit, work.remaining("fetchedRows"));
    if (rowLimit === 0) {
      work.partial("fetchedRows_limit");
      return [];
    }
    if (!work.take("queries")) return [];
    const ms = Math.max(
      1,
      Math.min(QUERY_EXECUTION_OPTIONS.timeoutMs, work.remainingMs()),
    );
    let rows: any[];
    try {
      rows = await withQueryTimeout(
        query.limit(rowLimit).toArray({ timeoutMs: ms }),
        "graph traversal",
        ms,
      );
    } catch (error) {
      if (
        !(error instanceof QueryTimeoutError) &&
        !(error instanceof Error && /timed out|timeout/i.test(error.message))
      )
        throw error;
      work.partial(ms < work.remainingMs() ? "query_timeout" : "deadline");
      return [];
    }
    // Count all returned rows, including rows later rejected by language/policy.
    work.counts.fetchedRows += rows.length;
    if (adjacency && rows.length >= rowLimit)
      work.partial("adjacency_row_limit");
    if (rowLimit < limit && rows.length >= rowLimit)
      work.partial("fetchedRows_limit");
    if (!work.active()) return [];
    const admitted: any[] = [];
    for (const row of rows) {
      const bounded = this.budgetRow(row, work);
      // Incomplete columns cannot establish identity, edge kind or checked absence.
      if (!bounded) break;
      admitted.push(bounded);
    }
    return admitted;
  }

  /** Bound symbol-array copies even for a single very wide chunk. Native row
   * decoding/bytes are outside this work contract; no full-store counting probes. */
  private budgetRow(row: any, work: GraphWorkBudget): any {
    const bounded = { ...row };
    for (const column of [
      "defined_symbols",
      "referenced_symbols",
      "member_referenced_symbols",
      "type_referenced_symbols",
    ]) {
      const values = row[column];
      if (values == null) continue;
      const out: string[] = [];
      for (let i = 0; i < (values.length ?? 0); i++) {
        if (!work.take("symbolItems")) return null;
        out.push(typeof values.get === "function" ? values.get(i) : values[i]);
      }
      bounded[column] = out;
    }
    return bounded;
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
    work?: GraphWorkBudget,
  ): Promise<GraphNode[]> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);

    // Find chunks that reference the symbol from a call position
    // (referenced_symbols) OR a type position (type_referenced_symbols). The
    // two are stored separately so type edges never inflate the call-edge count
    // used for ranking; navigation unions them.
    const rows = await this.queryRows(
      table
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
        ),
      100,
      work,
      true,
    );

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
  async getCallees(symbol: string, work?: GraphWorkBudget): Promise<string[]> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);

    // Find the definition of the symbol
    const rows = await this.queryRows(
      table
        .query()
        .select([
          "path",
          "referenced_symbols",
          "member_referenced_symbols",
          "content",
        ])
        .where(
          this.scopeWhere(`array_contains(defined_symbols, '${escaped}')`),
        ),
      1,
      work,
    );

    if (rows.length === 0) return [];

    const record = rows[0] as unknown as VectorRecord;
    const memberNames = toArr(record.member_referenced_symbols);
    const content = String(record.content ?? "");
    let localDefinitions: string[] = [];
    let localUnknown = false;
    if (record.path && memberNames.some(isBuiltinCallee)) {
      const query = table
        .query()
        .select(["defined_symbols"])
        .where(
          this.scopeWhere(`path = '${escapeSqlString(String(record.path))}'`),
        );
      const localRows = work
        ? await this.queryRows(query, 100, work, true)
        : await query.toArray(QUERY_EXECUTION_OPTIONS);
      localUnknown =
        !!work &&
        (localRows.length >= Math.min(100, work.limits.fetchedRows) ||
          work.stopped());
      localDefinitions = localRows.flatMap((row) =>
        toArr((row as any).defined_symbols),
      );
    }
    const members = new Set(memberNames);
    const local = new Set(localDefinitions);
    const out: string[] = [];
    for (const name of toArr(record.referenced_symbols)) {
      if (work && !work.active()) break;
      if (
        localUnknown ||
        !isBuiltinCallee(name) ||
        !members.has(name) ||
        local.has(name)
      ) {
        out.push(name);
        continue;
      }
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?<![\\w.$])${escapedName}\\s*\\(`).test(content))
        out.push(name);
    }
    return out;
  }

  /**
   * Build a 1-hop graph around a symbol.
   */
  async buildGraph(
    symbol: string,
    trace?: TraceCollector,
    work?: GraphWorkBudget,
  ): Promise<{
    center: GraphNode | null;
    callers: GraphNode[];
    callees: GraphNode[];
  }> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);

    // 1. Get Center (Definition)
    const centerRows = await this.queryRows(
      table
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
        .where(
          this.scopeWhere(`array_contains(defined_symbols, '${escaped}')`),
        ),
      1,
      work,
    );

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
        selectionBasis: center
          ? "first_definition_match"
          : work?.stopped()
            ? "unknown"
            : "no_candidate",
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
      work,
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
      if (work?.stopped()) break;
      const rows = await this.queryRows(
        table
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
          ]),
        25,
        work,
      );
      if (work?.stopped()) break;
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
    work?: GraphWorkBudget,
  ): Promise<string[]> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);
    const query = table
      .query()
      .select(["path"])
      .where(this.scopeWhere(`content LIKE '%import%${escaped}%'`));
    const rows = work
      ? await this.queryRows(query, 1000, work, true)
      : streamQueryRows(query, `content LIKE %import%${symbol}% (importers)`);

    const files = new Set<string>();
    let observed = 0;
    for await (const row of rows) {
      observed++;
      files.add(String((row as any).path || ""));
      if (files.size >= 100) {
        work?.partial("adjacency_row_limit");
        break;
      }
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
    traceOptions?: { requestedDepth?: number | null; work?: GraphWorkBudget },
  ): Promise<
    {
      center: GraphNode | null;
      callerTree: CallerTree[];
      callees: GraphNode[];
      importers: string[];
      work: GraphWorkSummary;
    } & Partial<TraceMetadata>
  > {
    const work = traceOptions?.work ?? new GraphWorkBudget();
    const trace = traceOptions
      ? createTraceCollector(traceOptions.requestedDepth ?? null, depth)
      : undefined;
    const visited = new Set<string>();
    if (work.take("visitedNodes")) visited.add(symbol);
    work.take("expansions");
    // Sequential admission keeps one request's query/row ledger deterministic.
    const graph = await this.buildGraph(symbol, trace, work);
    const importers = await this.getImporters(symbol, trace, work);
    const center =
      graph.center && work.take("resultNodes") ? graph.center : null;
    const callees = graph.callees.filter(() => work.take("resultNodes"));
    const initialCallers = graph.callers.slice(0, work.limits.queuedNodes);
    if (initialCallers.length < graph.callers.length) {
      work.partial("queuedNodes_limit");
      const dropped = graph.callers.length - initialCallers.length;
      recordTraceCoverage(trace, "caller_expansion", {
        observed: dropped,
        retained: 0,
        limit: work.limits.queuedNodes,
        limited: true,
        status: "partial",
        reasons: ["queuedNodes_limit"],
        omitted: { exact: null, lowerBound: dropped },
      });
    }
    work.queue(initialCallers.length);
    const callerTree = await this.expandCallers(
      initialCallers,
      center ? Math.max(0, depth - 1) : 0,
      visited,
      work,
      trace,
    );
    if (trace) {
      trace.coverage.work = work.snapshot();
      if (work.stopped()) {
        for (const stage of [
          "center_candidates",
          "caller_rows",
          "callee_spellings",
          "callee_candidates",
          "importer_files",
        ] as const) {
          recordTraceCoverage(trace, stage, {
            observed: 0,
            retained: 0,
            status: "unknown",
            limited: true,
            reasons: work.snapshot().reasons,
            omitted: { exact: null, lowerBound: 0 },
          });
        }
      }
    }
    return {
      center,
      callerTree,
      callees,
      importers,
      work: work.snapshot(),
      ...(trace
        ? {
            evidenceVersion: 1 as const,
            centerSelection: trace.centerSelection ?? {
              referenceSpelling: symbol,
              targetCandidate: null,
              selectionBasis: "unknown" as const,
            },
            coverage: trace.coverage,
          }
        : {}),
    };
  }

  private async expandCallers(
    callers: GraphNode[],
    remainingDepth: number,
    visited: Set<string>,
    work: GraphWorkBudget,
    trace?: TraceCollector,
    pending = 0,
    expanded = new Set(visited),
  ): Promise<CallerTree[]> {
    const trees: CallerTree[] = [];
    for (let i = 0; i < callers.length; i++) {
      const caller = callers[i];
      // Output occurrences and unique expanded spellings have distinct ceilings.
      if (!work.take("examinedEdges")) break;
      if (!visited.has(caller.symbol)) {
        if (!work.take("visitedNodes")) break;
        visited.add(caller.symbol);
      }
      if (!work.take("resultNodes")) break;
      const tree: CallerTree = { node: caller, callers: [] };
      trees.push(tree);
      if (expanded.has(caller.symbol)) {
        recordTraceCoverage(trace, "caller_expansion", {
          observed: 1,
          retained: 0,
          filteredByPolicy: 1,
          reasons: ["name_visited"],
        });
        continue;
      }
      if (remainingDepth <= 0) {
        work.partial("hop_limit");
        recordTraceCoverage(trace, "caller_expansion", {
          observed: 1,
          retained: 0,
          filteredByPolicy: 1,
          reasons: ["requested_depth_boundary"],
        });
        continue;
      }
      if (work.stopped() || !work.take("expansions")) continue;
      expanded.add(caller.symbol);
      recordTraceCoverage(trace, "caller_expansion", {
        observed: 1,
        retained: 1,
        limit: work.limits.visitedNodes,
      });
      const upstream = await this.getCallers(
        caller.symbol,
        languageFamilyForPath(caller.file),
        trace
          ? {
              collector: trace,
              targetCandidate: caller.evidence?.sourceChunk ?? null,
            }
          : undefined,
        work,
      );
      const pendingSiblings = pending + callers.length - i - 1;
      const available = Math.max(0, work.limits.queuedNodes - pendingSiblings);
      const admitted = upstream.slice(0, available);
      if (admitted.length < upstream.length) {
        work.partial("queuedNodes_limit");
        const dropped = upstream.length - admitted.length;
        recordTraceCoverage(trace, "caller_expansion", {
          observed: dropped,
          retained: 0,
          limit: work.limits.queuedNodes,
          limited: true,
          status: "partial",
          reasons: ["queuedNodes_limit"],
          omitted: { exact: null, lowerBound: dropped },
        });
      }
      work.queue(pendingSiblings + admitted.length);
      tree.callers = await this.expandCallers(
        admitted,
        remainingDepth - 1,
        visited,
        work,
        trace,
        pendingSiblings,
        expanded,
      );
    }
    const summary = work.snapshot();
    if (summary.status === "partial" && summary.outcome === "budget_limit") {
      recordTraceCoverage(trace, "caller_expansion", {
        observed: callers.length - trees.length,
        retained: 0,
        limit: work.limits.resultNodes,
        limited: true,
        status: "partial",
        reasons: summary.reasons,
        omitted: { exact: null, lowerBound: callers.length - trees.length },
      });
    }
    return trees;
  }

  // --- MCP graph primitives (Phase 7) -----------------------------------

  /** Symbols the given symbol references (outbound edges). */
  async calleesOf(symbol: string, work?: GraphWorkBudget): Promise<string[]> {
    return this.getCallees(symbol, work);
  }

  /** Distinct symbols that reference the given symbol (inbound edges). */
  async callersOf(symbol: string, work?: GraphWorkBudget): Promise<string[]> {
    const nodes = await this.getAnchoredCallers(symbol, work);
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
    work: GraphWorkBudget,
  ): (s: string) => Promise<string[]> {
    return direction === "callers"
      ? (s) => this.callersOf(s, work)
      : (s) => this.calleesOf(s, work);
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
    work = new GraphWorkBudget(),
  ): Promise<Array<NeighborHit & { file: string; line: number }>> {
    const hits = await bfsNeighbors(
      symbol,
      this.neighborFn(direction, work),
      maxHops,
      work.limits.visitedNodes,
      work,
    );
    // Resolve the origin once to anchor every neighbor's location lookup to the
    // same language family, so a shared name doesn't resolve to a foreign file.
    const origin = await this.resolveLocation(symbol, undefined, work);
    const anchorFamily = origin ? languageFamilyForPath(origin.file) : null;
    const out: Array<NeighborHit & { file: string; line: number }> = [];
    for (const h of hits) {
      const loc = await this.resolveLocation(h.symbol, anchorFamily, work);
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
    work = GraphWorkBudget.path(),
  ): Promise<string[] | null> {
    return findPath(
      from,
      to,
      this.neighborFn(direction, work),
      maxHops,
      work.limits.visitedNodes,
      work,
    );
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
    work?: GraphWorkBudget,
  ): Promise<{ file: string; line: number } | null> {
    const def = await this.resolveDefinition(symbol, anchorFamily, work);
    return def ? { file: def.file, line: def.line } : null;
  }

  /** Resolve a symbol to its defining chunk plus language family metadata. */
  async resolveDefinition(
    symbol: string,
    anchorFamily?: string | null,
    work?: GraphWorkBudget,
  ): Promise<GraphDefinition | null> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);
    const rows = await this.queryRows(
      table
        .query()
        .select(["path", "start_line", "is_exported"])
        .where(
          this.scopeWhere(`array_contains(defined_symbols, '${escaped}')`),
        ),
      // No anchor → keep the cheap single-row fetch. With one, pull a few
      // candidates so we can pick the same-family definition instead of guessing.
      anchorFamily ? 25 : 1,
      work,
    );
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

  async getAnchoredCallers(
    symbol: string,
    work?: GraphWorkBudget,
  ): Promise<GraphNode[]> {
    const def = await this.resolveDefinition(symbol, undefined, work);
    return this.getCallers(symbol, def?.family ?? null, undefined, work);
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
