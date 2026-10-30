import * as fs from "node:fs";
import * as path from "node:path";
import type { ChunkType, FileMetadata } from "../store/types";
import { resolveContainedFile } from "../utils/path-containment";

export type AgentSearchFormatOptions = {
  includeImports?: boolean;
  getImportsForFile?: (absPath: string) => string;
  explain?: boolean;
  /** The search query — hint lines prefer the chunk line matching its terms
   * over the chunk's first signature line. */
  query?: string;
};

function chunkPath(chunk: ChunkType): string {
  const metadata = chunk.metadata as FileMetadata | undefined;
  return String((chunk as any).path || metadata?.path || "");
}

function chunkStartLine(chunk: ChunkType): number {
  return Math.max(
    1,
    Number(
      (chunk as any).startLine ??
        (chunk as any).start_line ??
        chunk.generated_metadata?.start_line ??
        0,
    ) + 1,
  );
}

function definedSymbols(chunk: ChunkType): string[] {
  const raw = (chunk as any).defined_symbols ?? (chunk as any).definedSymbols;
  if (Array.isArray(raw))
    return raw.filter((v): v is string => typeof v === "string");
  if (raw && typeof raw.toArray === "function") {
    try {
      const arr = raw.toArray();
      if (Array.isArray(arr)) {
        return arr.filter((v): v is string => typeof v === "string");
      }
    } catch {}
  }
  return [];
}

function relativePath(projectRoot: string, absPath: string): string {
  if (!absPath) return "";
  return path.isAbsolute(absPath)
    ? path.relative(projectRoot, absPath)
    : absPath;
}

function firstSignatureLine(lines: string[]): number {
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*")
    ) {
      continue;
    }
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("File:")
    ) {
      continue;
    }
    if (trimmed === "{" || trimmed === "}") continue;
    if (/^[.),;:}\]|&(+`'"!~]/.test(trimmed)) continue;
    if (
      trimmed.startsWith("} ") ||
      trimmed.startsWith("- ") ||
      trimmed.startsWith("...")
    ) {
      continue;
    }
    return index;
  }
  return -1;
}

const QUERY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "where",
  "when",
  "how",
  "what",
  "does",
  "not",
  "are",
  "was",
  "has",
  "have",
  "its",
  "all",
  "can",
  "use",
  "uses",
  "using",
  "code",
]);

function extractQueryTerms(query: string | undefined): string[] {
  if (!query) return [];
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t));
  return [...new Set(terms)];
}

function truncateHint(line: string): string {
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * The chunk line that best matches the query terms — it shows *why* this
 * chunk hit, where the first signature line only shows what the chunk is.
 * Most distinct terms wins; code beats comments on a tie; earliest otherwise.
 */
function queryMatchingLine(lines: string[], terms: string[]): number {
  if (!terms.length) return -1;
  let best = -1;
  let bestScore = 0;
  let bestIsComment = true;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;
    if (trimmed.startsWith("import ") || trimmed.startsWith("File:")) continue;
    if (trimmed === "{" || trimmed === "}") continue;
    const lower = trimmed.toLowerCase();
    let score = 0;
    for (const t of terms) if (lower.includes(t)) score++;
    if (score === 0) continue;
    const isComment = /^(\/\/|\/\*|\*|#)/.test(trimmed);
    if (
      score > bestScore ||
      (score === bestScore && bestIsComment && !isComment)
    ) {
      best = index;
      bestScore = score;
      bestIsComment = isComment;
    }
  }
  return best;
}

/** Select only source lines in the chunk's own range, never embedding context. */
function hintFor(
  chunk: ChunkType,
  queryTerms: string[],
  sourceLines: string[] | null,
): { text: string; line: number } {
  const start = chunkStartLine(chunk);
  const end = Number(
    (chunk as any).endLine ??
      (chunk as any).end_line ??
      chunk.generated_metadata?.end_line ??
      start - 1 + Math.max(0, (chunk.generated_metadata?.num_lines ?? 1) - 1),
  );
  const raw = String((chunk as any).content ?? chunk.text ?? "");
  // Rich indexed text has no source offset metadata. Without the file, don't
  // attach a source pointer to breadcrumbs, imports or an appended docstring.
  const rich = raw.split("\n").some((line) => line.startsWith("File:"));
  const lines = sourceLines
    ? sourceLines.slice(start - 1, end + 1)
    : rich
      ? []
      : raw.split("\n").slice(0, end - start + 2);
  let index = queryMatchingLine(lines, queryTerms);
  if (index < 0) index = firstSignatureLine(lines);
  if (index < 0) {
    index = lines.findIndex(
      (line) => line.trim() && !/^(\/\/|\/\*|\*|#)/.test(line.trim()),
    );
  }
  if (index < 0) index = lines.findIndex((line) => line.trim());
  return index < 0
    ? { text: "", line: start }
    : { text: truncateHint(lines[index].trim()), line: start + index };
}

function explainSuffix(chunk: ChunkType, enabled?: boolean): string {
  if (!enabled || !chunk.scoreBreakdown) return "";
  const b = chunk.scoreBreakdown;
  return `\texplain:rerank=${b.rerank.toFixed(3)},fused=${b.fused.toFixed(3)},boost=${b.boost.toFixed(2)}x,score=${b.normalized.toFixed(3)}`;
}

export function formatAgentSearchResults(
  results: ChunkType[],
  projectRoot: string,
  options: AgentSearchFormatOptions = {},
): string {
  if (!results.length) return "(none)";

  const queryTerms = extractQueryTerms(options.query);
  const groups = new Map<string, ChunkType[]>();
  for (const result of results) {
    const absPath = chunkPath(result);
    const group = groups.get(absPath);
    if (group) group.push(result);
    else groups.set(absPath, [result]);
  }

  const lines: string[] = [];
  const seenImportFiles = new Set<string>();
  for (const [absPath, members] of groups) {
    const rel = relativePath(projectRoot, absPath);
    let sourceLines: string[] | null = null;
    try {
      sourceLines = fs
        .readFileSync(resolveContainedFile(projectRoot, absPath), "utf-8")
        .split("\n");
    } catch {
      // Deleted, offline or out-of-scope source: use only plainly mapped text.
    }

    if (
      options.includeImports &&
      absPath &&
      options.getImportsForFile &&
      !seenImportFiles.has(absPath)
    ) {
      seenImportFiles.add(absPath);
      const imports = options.getImportsForFile(absPath);
      if (imports) {
        lines.push(`[imports ${rel}] ${imports.split("\n").join(" | ")}`);
      }
    }

    const grouped = members.length > 1;
    if (grouped) {
      lines.push(`${rel} (${members.length} hits):`);
    }

    for (const result of members) {
      const symbol = definedSymbols(result)[0] ?? "";
      const role = String(result.role ?? "")
        .slice(0, 4)
        .toUpperCase();
      const score =
        typeof result.score === "number"
          ? `\ts=${result.score.toFixed(3)}`
          : "";
      const hint = hintFor(result, queryTerms, sourceLines);
      const locator = grouped ? `  :${hint.line}` : `${rel}:${hint.line}`;
      lines.push(
        `${locator}${score}${symbol ? ` ${symbol}` : ""}${role ? ` [${role}]` : ""}${hint.text ? ` — ${hint.text}` : ""}${explainSuffix(result, options.explain)}`,
      );
    }
  }

  return lines.join("\n");
}
