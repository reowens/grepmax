import * as path from "node:path";
import type { ChunkType, FileMetadata } from "../store/types";

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

function firstSignatureLine(chunk: ChunkType): string {
  const raw = (chunk as any).content ?? chunk.text ?? "";
  const lines = String(raw).split("\n");
  for (const line of lines) {
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
    if (
      /^[a-z]/.test(trimmed) &&
      !/^(export|function|class|interface|type|const|let|var|async|return|if|for|while|switch|enum|struct|pub |fn |def |impl |mod |use )/.test(
        trimmed,
      )
    ) {
      continue;
    }
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  }
  return "";
}

const QUERY_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "where",
  "when", "how", "what", "does", "not", "are", "was", "has", "have", "its",
  "all", "can", "use", "uses", "using", "code",
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
function queryMatchingLine(chunk: ChunkType, terms: string[]): string {
  if (!terms.length) return "";
  const raw = String((chunk as any).content ?? chunk.text ?? "");
  let best = "";
  let bestScore = 0;
  let bestIsComment = true;
  for (const line of raw.split("\n")) {
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
      best = trimmed;
      bestScore = score;
      bestIsComment = isComment;
    }
  }
  return truncateHint(best);
}

function hintFor(chunk: ChunkType, queryTerms: string[]): string {
  if (typeof chunk.summary === "string" && chunk.summary) {
    return chunk.summary;
  }
  return queryMatchingLine(chunk, queryTerms) || firstSignatureLine(chunk);
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
      const hint = hintFor(result, queryTerms);
      const locator = grouped
        ? `  :${chunkStartLine(result)}`
        : `${rel}:${chunkStartLine(result)}`;
      lines.push(
        `${locator}${score}${symbol ? ` ${symbol}` : ""}${role ? ` [${role}]` : ""}${hint ? ` — ${hint}` : ""}${explainSuffix(result, options.explain)}`,
      );
    }
  }

  return lines.join("\n");
}
