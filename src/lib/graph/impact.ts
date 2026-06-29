import { languageFamilyForPath } from "../core/languages";
import type { VectorDB } from "../store/vector-db";
import {
  escapeSqlString,
  pathNotStartsWith,
  pathStartsWith,
} from "../utils/filter-builder";
import { withQueryTimeout } from "../utils/query-timeout";
import { GraphBuilder } from "./graph-builder";

const TEST_DIR_RE = /(^|\/)(__tests__|tests?|specs?|benchmark)(\/|$)/i;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
// Swift/Kotlin/Java: FooTests.swift, FooTest.kt, FooTest.java, or dirs like AppTests/
const NATIVE_TEST_DIR_RE = /(^|\/)\w+Tests?(\/|$)/;
const NATIVE_TEST_FILE_RE = /Tests?\.(swift|kt|java)$/;

export function isTestPath(filePath: string): boolean {
  return (
    TEST_DIR_RE.test(filePath) ||
    TEST_FILE_RE.test(filePath) ||
    NATIVE_TEST_DIR_RE.test(filePath) ||
    NATIVE_TEST_FILE_RE.test(filePath)
  );
}

import { toArr } from "../utils/arrow";

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

export type SymbolFamilyMap = Map<string, string | null>;

export interface ResolvedTargetSymbols {
  symbols: string[];
  resolvedAsFile: boolean;
  symbolFamilies?: SymbolFamilyMap;
}

/**
 * Resolve a target (symbol name or file path) to a list of defined symbols.
 */
export async function resolveTargetSymbols(
  target: string,
  vectorDb: VectorDB,
  projectRoot: string,
): Promise<ResolvedTargetSymbols> {
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
    const family = languageFamilyForPath(absPath);
    return {
      symbols: [...symbols],
      resolvedAsFile: true,
      symbolFamilies: new Map([...symbols].map((s) => [s, family])),
    };
  }

  return { symbols: [target], resolvedAsFile: false };
}

function familyMatchesPath(
  anchorFamily: string | null,
  filePath: string,
): boolean {
  if (anchorFamily == null) return true;
  const family = languageFamilyForPath(filePath);
  return family == null || family === anchorFamily;
}

async function resolveSymbolFamilies(
  symbols: string[],
  vectorDb: VectorDB,
  projectRoot: string,
  excludePrefixes?: string[],
  seed?: SymbolFamilyMap,
): Promise<SymbolFamilyMap> {
  const families = new Map(seed);
  const missing = symbols.filter((s) => !families.has(s));
  if (missing.length === 0) return families;

  const table = await vectorDb.ensureTable();
  const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  let pathScope = pathStartsWith(prefix);
  for (const ex of excludePrefixes ?? []) {
    const exNorm = ex.endsWith("/") ? ex : `${ex}/`;
    pathScope += ` AND ${pathNotStartsWith(exNorm)}`;
  }

  for (const sym of missing) {
    const rows = await table
      .query()
      .select(["path"])
      .where(
        `array_contains(defined_symbols, '${escapeSqlString(sym)}') AND ${pathScope}`,
      )
      .limit(25)
      .toArray();
    const file = String((rows[0] as any)?.path || "");
    families.set(sym, file ? languageFamilyForPath(file) : null);
  }

  return families;
}

/**
 * For a single symbol, expand to include all symbols defined in the same file.
 * This catches cases where tests call methods of a class rather than the class name itself
 * (e.g., Swift tests call `handleNotification()` rather than referencing `DeepLinkRouter`).
 */
async function expandFileSymbols(
  symbols: string[],
  vectorDb: VectorDB,
  projectRoot: string,
  excludePrefixes?: string[],
): Promise<string[]> {
  if (symbols.length !== 1) return symbols;

  const table = await vectorDb.ensureTable();
  const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;

  let where = `array_contains(defined_symbols, '${escapeSqlString(symbols[0])}') AND ${pathStartsWith(prefix)}`;
  for (const ex of excludePrefixes ?? []) {
    const exNorm = ex.endsWith("/") ? ex : `${ex}/`;
    where += ` AND ${pathNotStartsWith(exNorm)}`;
  }

  // Find the file that defines this symbol
  const defRows = await table
    .query()
    .select(["path"])
    .where(where)
    .limit(1)
    .toArray();

  if (defRows.length === 0) return symbols;
  const filePath = String((defRows[0] as any).path);

  // Get ALL symbols defined in that file
  const fileRows = await table
    .query()
    .select(["defined_symbols"])
    .where(`path = '${escapeSqlString(filePath)}'`)
    .toArray();

  const expanded = new Set<string>(symbols);
  for (const row of fileRows) {
    for (const s of toArr((row as any).defined_symbols)) {
      expanded.add(s);
    }
  }
  // Cap the fan-out: a large class file can define 50+ symbols, and every
  // expanded symbol costs one caller-scan (and more in the fallback). The
  // original target stays first; co-defined symbols are best-effort extras.
  const MAX_EXPANDED = 15;
  return [...expanded].slice(0, MAX_EXPANDED);
}

/**
 * Find test files that exercise a set of symbols, using reverse call graph traversal.
 * When the call-graph walk returns nothing, falls back to test files that
 * reference the symbol via referenced_symbols or textual content match —
 * catching the common case where a test imports a symbol but doesn't call it
 * through the graph the chunker captures (UI components, mocked modules, etc).
 * Fallback hits are tagged with hops = -1.
 */
export async function findTests(
  symbols: string[],
  vectorDb: VectorDB,
  projectRoot: string,
  depth = 1,
  excludePrefixes?: string[],
  symbolFamilies?: SymbolFamilyMap,
): Promise<TestHit[]> {
  const graphBuilder = new GraphBuilder(vectorDb, projectRoot, excludePrefixes);
  const testHits = new Map<string, TestHit>(); // key: file+symbol

  // Expand single-symbol targets to include all symbols from the same file
  const expanded = await expandFileSymbols(
    symbols,
    vectorDb,
    projectRoot,
    excludePrefixes,
  );
  const families = await resolveSymbolFamilies(
    expanded,
    vectorDb,
    projectRoot,
    excludePrefixes,
    symbolFamilies,
  );

  for (const symbol of expanded) {
    await walkCallers(
      symbol,
      graphBuilder,
      testHits,
      0,
      depth,
      new Set(),
      families.get(symbol) ?? null,
    );
  }

  if (testHits.size === 0) {
    const importFiles = await findImportFallbackTests(
      expanded,
      symbols,
      vectorDb,
      projectRoot,
      excludePrefixes,
      families,
    );
    for (const file of importFiles) {
      testHits.set(`${file}:(referenced)`, {
        file,
        symbol: "(referenced)",
        line: 0,
        hops: -1,
      });
    }
  }

  return [...testHits.values()].sort(
    (a, b) => a.hops - b.hops || a.file.localeCompare(b.file),
  );
}

async function findImportFallbackTests(
  expandedSymbols: string[],
  originalSymbols: string[],
  vectorDb: VectorDB,
  projectRoot: string,
  excludePrefixes?: string[],
  symbolFamilies?: SymbolFamilyMap,
): Promise<Set<string>> {
  const files = new Set<string>();

  // Signal 1: referenced_symbols match (precise; works when the chunker
  // captured call references in test bodies). Uses the expanded set so tests
  // that call a method of the target class still match.
  const dependents = await findDependents(
    expandedSymbols,
    vectorDb,
    projectRoot,
    undefined,
    50,
    excludePrefixes,
    symbolFamilies,
  );
  for (const d of dependents) {
    if (isTestPath(d.file)) files.add(d.file);
  }

  // Signal 2: content LIKE match (textual; survives chunker quirks where a
  // test body's referenced_symbols ends up empty).
  const table = await vectorDb.ensureTable();
  const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  let pathScope = pathStartsWith(prefix);
  for (const ex of excludePrefixes ?? []) {
    const exNorm = ex.endsWith("/") ? ex : `${ex}/`;
    pathScope += ` AND ${pathNotStartsWith(exNorm)}`;
  }
  // Textual matching runs on the ORIGINAL targets only: matching co-defined
  // file symbols (helpers like `log`) textually drags in every test file
  // that mentions them, drowning the answer in false positives.
  for (const sym of originalSymbols) {
    const family = symbolFamilies?.get(sym) ?? null;
    // No .limit() here: LIKE + limit deadlocks in @lancedb 0.27.x when more
    // rows match than the limit (verified). Unlimited scan is fast; cap in JS.
    const rows = await withQueryTimeout(
      table
        .query()
        .select(["path"])
        .where(`content LIKE '%${escapeSqlString(sym)}%' AND ${pathScope}`)
        .toArray(),
      `content LIKE %${sym}% (test fallback)`,
    );
    for (const row of rows.slice(0, 500)) {
      const p = String((row as any).path || "");
      if (isTestPath(p) && familyMatchesPath(family, p)) files.add(p);
    }
  }

  return files;
}

async function walkCallers(
  symbol: string,
  graphBuilder: GraphBuilder,
  testHits: Map<string, TestHit>,
  currentHop: number,
  maxDepth: number,
  visited: Set<string>,
  anchorFamily: string | null,
): Promise<void> {
  if (visited.has(symbol)) return;
  visited.add(symbol);

  const callers = await graphBuilder.getCallers(symbol, anchorFamily);
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
      await walkCallers(
        caller.symbol,
        graphBuilder,
        testHits,
        currentHop + 1,
        maxDepth,
        visited,
        languageFamilyForPath(caller.file),
      );
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
  excludePrefixes?: string[],
  symbolFamilies?: SymbolFamilyMap,
): Promise<DependentHit[]> {
  const table = await vectorDb.ensureTable();
  let pathScope = pathStartsWith(`${projectRoot}/`);
  for (const ex of excludePrefixes ?? []) {
    const exNorm = ex.endsWith("/") ? ex : `${ex}/`;
    pathScope += ` AND ${pathNotStartsWith(exNorm)}`;
  }
  const symbolsByFile = new Map<string, Set<string>>();
  const families = await resolveSymbolFamilies(
    symbols,
    vectorDb,
    projectRoot,
    excludePrefixes,
    symbolFamilies,
  );

  for (const sym of symbols) {
    const family = families.get(sym) ?? null;
    // 200, not 20: with per-chunk rows a popular symbol easily exceeds 20
    // chunks, and truncation here silently drops whole dependent files.
    // (array_contains + limit does not hit the LIKE+limit native hang.)
    const rows = await table
      .query()
      .select(["path"])
      .where(
        `(array_contains(referenced_symbols, '${escapeSqlString(sym)}') OR array_contains(type_referenced_symbols, '${escapeSqlString(sym)}')) AND ${pathScope}`,
      )
      .limit(200)
      .toArray();

    for (const row of rows) {
      const p = String((row as any).path || "");
      if (excludePaths?.has(p)) continue;
      if (!familyMatchesPath(family, p)) continue;
      const set = symbolsByFile.get(p) ?? new Set<string>();
      set.add(sym);
      symbolsByFile.set(p, set);
    }
  }

  return Array.from(symbolsByFile.entries())
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, limit)
    .map(([file, symbols]) => ({ file, sharedSymbols: symbols.size }));
}
