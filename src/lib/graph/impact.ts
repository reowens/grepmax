import type { VectorDB } from "../store/vector-db";
import { escapeSqlString } from "../utils/filter-builder";
import { GraphBuilder } from "./graph-builder";

const TEST_DIR_RE = /(^|\/)(__tests__|tests?|specs?|benchmark)(\/|$)/i;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

export function isTestPath(filePath: string): boolean {
  return TEST_DIR_RE.test(filePath) || TEST_FILE_RE.test(filePath);
}

function toArr(val: unknown): string[] {
  if (val && typeof (val as any).toArray === "function") {
    return (val as any).toArray();
  }
  return Array.isArray(val) ? val : [];
}

export interface TestHit {
  file: string;
  symbol: string;
  line: number;
  hops: number; // 0 = direct caller, 1 = caller-of-caller, etc.
}

export interface DependentHit {
  file: string;
  sharedSymbols: number;
}

/**
 * Resolve a target (symbol name or file path) to a list of defined symbols.
 */
export async function resolveTargetSymbols(
  target: string,
  vectorDb: VectorDB,
  projectRoot: string,
): Promise<{ symbols: string[]; resolvedAsFile: boolean }> {
  // If target looks like a file path (contains / or .)
  if (target.includes("/") || (target.includes(".") && !target.includes(" "))) {
    const absPath = target.startsWith("/")
      ? target
      : `${projectRoot}/${target}`;
    const table = await vectorDb.ensureTable();
    const chunks = await table
      .query()
      .select(["defined_symbols"])
      .where(`path = '${escapeSqlString(absPath)}'`)
      .toArray();

    const symbols = new Set<string>();
    for (const chunk of chunks) {
      for (const s of toArr((chunk as any).defined_symbols)) {
        symbols.add(s);
      }
    }
    return { symbols: [...symbols], resolvedAsFile: true };
  }

  return { symbols: [target], resolvedAsFile: false };
}

/**
 * Find test files that exercise a set of symbols, using reverse call graph traversal.
 */
export async function findTests(
  symbols: string[],
  vectorDb: VectorDB,
  projectRoot: string,
  depth = 1,
): Promise<TestHit[]> {
  const graphBuilder = new GraphBuilder(vectorDb, projectRoot);
  const testHits = new Map<string, TestHit>(); // key: file+symbol

  for (const symbol of symbols) {
    await walkCallers(symbol, graphBuilder, testHits, 0, depth, new Set());
  }

  return [...testHits.values()].sort((a, b) => a.hops - b.hops || a.file.localeCompare(b.file));
}

async function walkCallers(
  symbol: string,
  graphBuilder: GraphBuilder,
  testHits: Map<string, TestHit>,
  currentHop: number,
  maxDepth: number,
  visited: Set<string>,
): Promise<void> {
  if (visited.has(symbol)) return;
  visited.add(symbol);

  const callers = await graphBuilder.getCallers(symbol);
  for (const caller of callers) {
    if (isTestPath(caller.file)) {
      const key = `${caller.file}:${caller.symbol}`;
      if (!testHits.has(key)) {
        testHits.set(key, {
          file: caller.file,
          symbol: caller.symbol,
          line: caller.line,
          hops: currentHop,
        });
      }
    }

    // Continue walking callers if within depth
    if (currentHop < maxDepth - 1) {
      await walkCallers(caller.symbol, graphBuilder, testHits, currentHop + 1, maxDepth, visited);
    }
  }
}

/**
 * Find files that depend on (reference) any of the given symbols.
 * Returns files sorted by number of shared symbols (descending).
 */
export async function findDependents(
  symbols: string[],
  vectorDb: VectorDB,
  projectRoot: string,
  excludePaths?: Set<string>,
  limit = 10,
): Promise<DependentHit[]> {
  const table = await vectorDb.ensureTable();
  const pathScope = `path LIKE '${escapeSqlString(projectRoot)}/%'`;
  const counts = new Map<string, number>();

  for (const sym of symbols) {
    const rows = await table
      .query()
      .select(["path"])
      .where(
        `array_contains(referenced_symbols, '${escapeSqlString(sym)}') AND ${pathScope}`,
      )
      .limit(20)
      .toArray();

    for (const row of rows) {
      const p = String((row as any).path || "");
      if (excludePaths?.has(p)) continue;
      counts.set(p, (counts.get(p) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file, sharedSymbols]) => ({ file, sharedSymbols }));
}
