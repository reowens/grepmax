import type { VectorRecord } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { escapeSqlString } from "../utils/filter-builder";
import { withQueryTimeout } from "../utils/query-timeout";
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
}

export interface CallerTree {
  node: GraphNode;
  callers: CallerTree[];
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
      result = `${result} AND path LIKE '${escapeSqlString(this.pathPrefix)}%'`;
    }
    for (const ex of this.excludePrefixes) {
      result = `${result} AND path NOT LIKE '${escapeSqlString(ex)}%'`;
    }
    return result;
  }

  /**
   * Find all chunks that call the given symbol.
   */
  async getCallers(symbol: string): Promise<GraphNode[]> {
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

    return rows.map((row) =>
      this.mapRowToNode(row as unknown as VectorRecord, symbol, "caller"),
    );
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

    // 2. Get Callers
    const callers = await this.getCallers(symbol);

    // 3. Get Callees — resolve each to a GraphNode with file:line
    const calleeNames = center ? center.calls.slice(0, 15) : [];
    const calleeNodes: GraphNode[] = [];
    for (const name of calleeNames) {
      const esc = escapeSqlString(name);
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
        .limit(1)
        .toArray();
      if (rows.length > 0) {
        calleeNodes.push(
          this.mapRowToNode(rows[0] as unknown as VectorRecord, name, "center"),
        );
      } else {
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
        const upstreamCallers = await this.getCallers(caller.symbol);
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
    const nodes = await this.getCallers(symbol);
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
    const out: Array<NeighborHit & { file: string; line: number }> = [];
    for (const h of hits) {
      const loc = await this.resolveLocation(h.symbol);
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

  /** Resolve a symbol to its first defining chunk's file:line, if indexed. */
  async resolveLocation(
    symbol: string,
  ): Promise<{ file: string; line: number } | null> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);
    const rows = await table
      .query()
      .select(["path", "start_line"])
      .where(this.scopeWhere(`array_contains(defined_symbols, '${escaped}')`))
      .limit(1)
      .toArray();
    if (rows.length === 0) return null;
    const r = rows[0] as any;
    return { file: String(r.path || ""), line: Number(r.start_line || 0) };
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

    return {
      symbol,
      file: row.path,
      line: row.start_line,
      role: row.role || "IMPLEMENTATION",
      calls: referencedSymbols,
      calledBy: [], // To be filled if we do reverse lookup
      complexity: row.complexity,
    };
  }
}
