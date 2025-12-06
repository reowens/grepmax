import type { VectorRecord } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { escapeSqlString } from "../utils/filter-builder";

export interface GraphNode {
  symbol: string;
  file: string;
  line: number;
  role: string;
  calls: string[];
  calledBy: string[];
  complexity?: number;
}

export class GraphBuilder {
  constructor(private db: VectorDB) {}

  /**
   * Find all chunks that call the given symbol.
   */
  async getCallers(symbol: string): Promise<GraphNode[]> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);

    // Find chunks where referenced_symbols contains the symbol
    const rows = await table
      .query()
      .where(`array_contains(referenced_symbols, '${escaped}')`)
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
      .where(`array_contains(defined_symbols, '${escaped}')`)
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
    callees: string[];
  }> {
    const table = await this.db.ensureTable();
    const escaped = escapeSqlString(symbol);

    // 1. Get Center (Definition)
    const centerRows = await table
      .query()
      .where(`array_contains(defined_symbols, '${escaped}')`)
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

    // 3. Get Callees (from center)
    const callees = center ? center.calls : [];

    return { center, callers, callees };
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
