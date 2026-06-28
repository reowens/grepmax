/**
 * Call-site resolution for chunk-granularity caller edges.
 *
 * `GraphBuilder.getCallers()` returns one row per *chunk* whose
 * referenced_symbols contains the target — for a large class split into many
 * chunks that means many rows pointing at chunk boundaries, not call sites.
 * These helpers re-anchor each caller row to the actual line that mentions the
 * target symbol and collapse duplicates, so consumers (trace, peek, impact)
 * report real call sites with true counts.
 */
import * as fs from "node:fs";

export interface ResolvedCaller {
  symbol: string;
  file: string;
  /** Chunk-start line (0-based) — kept for callers that need it. */
  line: number;
  /** The source line containing the target symbol, trimmed; null when the
   * reference was rolled up to a parent scope and no line matched. */
  snippet: string | null;
  /** 0-based line of the snippet, or null. */
  snippetLine: number | null;
}

export function findCallSiteSnippet(
  fileCache: Map<string, string[]>,
  callerFile: string,
  callerLine: number,
  targetSymbol: string,
): { snippet: string; snippetLine: number } | null {
  if (!callerFile) return null;
  let lines = fileCache.get(callerFile);
  if (!lines) {
    try {
      lines = fs.readFileSync(callerFile, "utf-8").split("\n");
    } catch {
      return null;
    }
    fileCache.set(callerFile, lines);
  }
  // Search a bounded window starting at the caller's definition line.
  const start = Math.max(0, callerLine);
  const end = Math.min(lines.length, callerLine + 200);
  const wordRe = new RegExp(
    `\\b${targetSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
  );
  for (let i = start; i < end; i++) {
    if (wordRe.test(lines[i])) {
      return { snippet: lines[i].trim(), snippetLine: i };
    }
  }
  // Window didn't contain the symbol — chunker rolled the reference up to a
  // parent scope. Skip the snippet rather than showing a misleading default;
  // the caller's file:line is still emitted.
  return null;
}

/**
 * Resolve chunk-level caller rows to deduplicated call sites. Rows from
 * different chunks of the same file that resolve to the same source line
 * collapse into one entry; rows whose window doesn't contain the symbol
 * dedupe by file+symbol so split-chunk spam can't multiply them.
 */
export function resolveCallSites(
  callers: Array<{ symbol: string; file: string; line: number }>,
  targetSymbol: string,
  fileCache: Map<string, string[]> = new Map(),
): ResolvedCaller[] {
  const out: ResolvedCaller[] = [];
  const seen = new Set<string>();
  for (const c of callers) {
    const snippet = findCallSiteSnippet(
      fileCache,
      c.file,
      c.line,
      targetSymbol,
    );
    const key = snippet
      ? `${c.file}:${snippet.snippetLine}`
      : `${c.file}:${c.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      symbol: c.symbol,
      file: c.file,
      line: c.line,
      snippet: snippet?.snippet ?? null,
      snippetLine: snippet?.snippetLine ?? null,
    });
  }
  return out;
}

/**
 * Identifiers that read as "callees" in referenced_symbols but are language
 * or runtime builtins — listing them as "(not indexed)" callees is noise.
 * Only consulted for UNRESOLVED names; a project symbol that shadows one of
 * these still shows up because it resolves to an indexed definition.
 */
const BUILTIN_CALLEES = new Set([
  // Object/primitive methods
  "toString",
  "valueOf",
  "hasOwnProperty",
  // Array/String methods
  "push",
  "pop",
  "shift",
  "unshift",
  "slice",
  "splice",
  "concat",
  "join",
  "map",
  "filter",
  "reduce",
  "forEach",
  "find",
  "findIndex",
  "some",
  "every",
  "includes",
  "indexOf",
  "lastIndexOf",
  "sort",
  "reverse",
  "flat",
  "flatMap",
  "keys",
  "values",
  "entries",
  "fill",
  "split",
  "trim",
  "trimStart",
  "trimEnd",
  "replace",
  "replaceAll",
  "match",
  "matchAll",
  "test",
  "exec",
  "padStart",
  "padEnd",
  "repeat",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "startsWith",
  "endsWith",
  "toLowerCase",
  "toUpperCase",
  "substring",
  "substr",
  "localeCompare",
  "normalize",
  // Map/Set methods
  "get",
  "set",
  "has",
  "add",
  "delete",
  "clear",
  // Math/Date/Number members
  "trunc",
  "floor",
  "ceil",
  "round",
  "abs",
  "min",
  "max",
  "random",
  "pow",
  "sqrt",
  "log2",
  "log10",
  "sign",
  "now",
  "parse",
  "parseInt",
  "parseFloat",
  "isInteger",
  "isFinite",
  "isNaN",
  "toFixed",
  "toISOString",
  // Promise/Function members
  "then",
  "catch",
  "finally",
  "resolve",
  "reject",
  "all",
  "allSettled",
  "race",
  "any",
  "call",
  "apply",
  "bind",
  // JSON / global constructors & functions
  "JSON",
  "stringify",
  "Math",
  "Date",
  "Promise",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Buffer",
  "URL",
  "URLSearchParams",
  "isArray",
  "from",
  "of",
  "assign",
  "freeze",
  "create",
  "getOwnPropertyNames",
  "fromEntries",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  "structuredClone",
  "fetch",
  "console",
  "process",
  "require",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "atob",
  "btoa",
  // console members
  "warn",
  "info",
  "debug",
  "trace",
  "table",
  "dir",
  "group",
  "groupEnd",
  "assert",
  "time",
  "timeEnd",
]);

/** True when an UNRESOLVED callee name is a known JS/TS builtin. */
export function isBuiltinCallee(name: string): boolean {
  return BUILTIN_CALLEES.has(name);
}
