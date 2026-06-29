import { languageFamilyForPath } from "../core/languages";
import type { VectorRecord } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import {
  escapeSqlString,
  pathNotStartsWith,
  pathStartsWith,
} from "../utils/filter-builder";
import { withQueryTimeout } from "../utils/query-timeout";
import { isBuiltinCallee } from "./callsites";
import {
  bfsNeighbors,
  buildFileSubgraph,
  type FileSubgraph,
  findPath,
  type NeighborHit,
} from "./graph-traversal";

export type EdgeDirection = "callers" | "callees";

export interface GraphNode {
  symbol: string;
  file: string;
  line: number;
  role: string;
  calls: string[];
  calledBy: string[];
  complexity?: number;
  /**
   * Edge provenance for a caller node (how this chunk references the target):
   * `free` = a free call `T()` (call position, high confidence) ·
   * `member` = a member call `x.T()` (receiver unknown, low confidence) ·
   * `type` = a type-position reference `: T` (not a call at all, lowest).
   * Undefined for center/callee nodes. Drives the confidence sort + tag.
   */
  edgeKind?: "free" | "member" | "type";
  /** EXTRACTED = a direct free call (trustworthy); INFERRED = member/type edge. */
  confidence?: "EXTRACTED" | "INFERRED";
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
      .toArray();

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

    const nodes = guarded.map((row) =>
      this.mapRowToNode(row as unknown as VectorRecord, symbol, "caller"),
    );

    // Caller-side builtin-member suppression. A member call `x.T()` to a builtin
    // name T (`.get`/`.map`/`.forEach`) is almost always an unrelated stdlib
    // method, not a real caller of the project symbol T — mirrors the callee-side
    // guard in buildGraph. Only fires when T itself is a builtin name, so a normal
    // symbol that merely has member callers is untouched.
    const filtered = isBuiltinCallee(symbol)
      ? nodes.filter((n) => n.edgeKind !== "member")
      : nodes;

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
      .select(["referenced_symbols"])
      .where(this.scopeWhere(`array_contains(defined_symbols, '${escaped}')`))
      .limit(1)
      .toArray();

    if (rows.length === 0) return [];

    const record = rows[0] as unknown as VectorRecord;
    return record.referenced_symbols || [];
  }

  /**
   * Build a 1-hop graph around a symbol.
   */
  async buildGraph(symbol: string): Promise<{
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
        "defined_symbols",
        "referenced_symbols",
        "role",
        "parent_symbol",
        "complexity",
      ])
      .where(this.scopeWhere(`array_contains(defined_symbols, '${escaped}')`))
      .limit(1)
      .toArray();

    const center =
      centerRows.length > 0
        ? this.mapRowToNode(
            centerRows[0] as unknown as VectorRecord,
            symbol,
            "center",
          )
        : null;

    // 2. Get Callers — anchored to the center definition's language family so a
    // bare name shared across languages doesn't pull in cross-language callers.
    const centerFamily = center ? languageFamilyForPath(center.file) : null;
    const callers = await this.getCallers(symbol, centerFamily);

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
          "defined_symbols",
          "referenced_symbols",
          "role",
          "parent_symbol",
          "complexity",
        ])
        .limit(25)
        .toArray();
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
        calleeNodes.push(
          this.mapRowToNode(
            (selfRow ?? familyRow ?? rows[0]) as unknown as VectorRecord,
            name,
            "center",
          ),
        );
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
        });
      }
    }

    return { center, callers, callees: calleeNodes };
  }

  async getImporters(symbol: string): Promise<string[]> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);
    // No .limit() here: LIKE + limit deadlocks in @lancedb 0.27.x when more
    // rows match than the limit (verified). Unlimited scan is fast; cap in JS.
    const rows = await withQueryTimeout(
      table
        .query()
        .select(["path"])
        .where(this.scopeWhere(`content LIKE '%import%${escaped}%'`))
        .toArray(),
      `content LIKE %import%${symbol}% (importers)`,
    );

    const files = new Set<string>();
    for (const row of rows) {
      files.add(String((row as any).path || ""));
      if (files.size >= 100) break;
    }
    return Array.from(files);
  }

  async buildGraphMultiHop(
    symbol: string,
    depth: number,
  ): Promise<{
    center: GraphNode | null;
    callerTree: CallerTree[];
    callees: GraphNode[];
    importers: string[];
  }> {
    const [graph, importers] = await Promise.all([
      this.buildGraph(symbol),
      this.getImporters(symbol),
    ]);

    if (depth <= 1 || !graph.center) {
      return {
        center: graph.center,
        callerTree: graph.callers.map((c) => ({ node: c, callers: [] })),
        callees: graph.callees,
        importers,
      };
    }

    const visited = new Set<string>([symbol]);
    const callerTree = await this.expandCallers(
      graph.callers,
      depth - 1,
      visited,
    );

    return {
      center: graph.center,
      callerTree,
      callees: graph.callees,
      importers,
    };
  }

  private static readonly MAX_VISITED = 500;

  private async expandCallers(
    callers: GraphNode[],
    remainingDepth: number,
    visited: Set<string>,
  ): Promise<CallerTree[]> {
    if (remainingDepth <= 0 || visited.size > GraphBuilder.MAX_VISITED) {
      return callers.map((c) => ({ node: c, callers: [] }));
    }

    const trees: CallerTree[] = [];
    for (const caller of callers) {
      if (visited.has(caller.symbol)) {
        trees.push({ node: caller, callers: [] });
        continue;
      }
      visited.add(caller.symbol);

      let subCallers: CallerTree[] = [];
      if (remainingDepth > 0) {
        const upstreamCallers = await this.getCallers(
          caller.symbol,
          languageFamilyForPath(caller.file),
        );
        subCallers = await this.expandCallers(
          upstreamCallers,
          remainingDepth - 1,
          visited,
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
      .toArray();
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
      .toArray();

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
