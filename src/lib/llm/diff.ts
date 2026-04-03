import { execFileSync } from "node:child_process";

export interface CommitInfo {
  hash: string;
  short: string;
  message: string;
  author: string;
  date: string;
}

export const DIFF_MAX_LINES = 500;
export const SYMBOL_MAX = 10;

const KEYWORD_SKIP = new Set([
  "public", "private", "internal", "protected", "open", "final", "static",
  "override", "class", "struct", "enum", "func", "function", "def", "const",
  "let", "var", "export", "async", "await", "import", "return", "if", "else",
  "for", "while", "switch", "case", "guard", "interface", "abstract", "sealed",
  "data", "suspend", "inline", "typealias", "extension", "protocol", "throws",
  "mutating", "nonmutating", "convenience", "required", "weak", "unowned",
  "lazy", "dynamic", "optional", "objc", "nonisolated", "isolated",
  "consuming", "borrowing",
]);

const DECL_RE = /(?:function|class|struct|enum|interface|func|def)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
const IDENT_RE = /[a-zA-Z_][a-zA-Z0-9_]*/g;

const LANG_MAP: [RegExp, string][] = [
  [/\.(ts|tsx|js|jsx)$/, "typescript"],
  [/\.swift$/, "swift"],
  [/\.(kt|kts)$/, "kotlin"],
  [/\.py$/, "python"],
  [/\.go$/, "go"],
  [/\.rs$/, "rust"],
];

function git(args: string[], root: string): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Extract unified diff from a commit. Returns null for empty diffs (merges, amends).
 * Truncates to DIFF_MAX_LINES if needed.
 */
export function extractDiff(ref: string, root: string): string | null {
  let raw: string;
  try {
    raw = git(["diff-tree", "-p", "--no-commit-id", ref], root);
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  const lines = raw.split("\n");
  if (lines.length <= DIFF_MAX_LINES) return raw;

  const truncated = lines.slice(0, DIFF_MAX_LINES);
  truncated.push(
    "",
    `... [truncated — ${lines.length} total lines, showing first ${DIFF_MAX_LINES}]`,
  );
  return truncated.join("\n");
}

/**
 * Read commit metadata. Throws if ref is invalid.
 */
export function readCommitInfo(ref: string, root: string): CommitInfo {
  const raw = git(["log", "-1", "--format=%H|%h|%s|%an|%ai", ref], root).trim();
  const parts = raw.split("|");
  return {
    hash: parts[0],
    short: parts[1],
    message: parts.slice(2, -2).join("|"), // message may contain |
    author: parts[parts.length - 2],
    date: parts[parts.length - 1],
  };
}

/**
 * List files changed in a commit.
 */
export function extractChangedFiles(ref: string, root: string): string[] {
  try {
    const raw = git(["diff-tree", "--no-commit-id", "--name-only", "-r", ref], root);
    return raw.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Extract symbol names from a unified diff.
 * Pass 1: hunk headers (git auto-detects enclosing function/class).
 * Pass 2: added-line declaration patterns.
 */
export function extractSymbols(diff: string): string[] {
  const symbols = new Set<string>();

  for (const line of diff.split("\n")) {
    // Pass 1: hunk headers
    if (line.startsWith("@@")) {
      const ctx = line.replace(/^@@[^@]*@@\s*/, "");
      if (!ctx) continue;
      const idents: string[] = [];
      let m: RegExpExecArray | null;
      IDENT_RE.lastIndex = 0;
      while ((m = IDENT_RE.exec(ctx)) !== null) {
        if (!KEYWORD_SKIP.has(m[0])) idents.push(m[0]);
      }
      if (idents.length > 0) symbols.add(idents[idents.length - 1]);
      continue;
    }

    // Pass 2: added lines with declarations
    if (line.startsWith("+") && !line.startsWith("+++")) {
      DECL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DECL_RE.exec(line)) !== null) {
        symbols.add(m[1]);
      }
    }
  }

  // Filter short identifiers and cap
  return [...symbols]
    .filter((s) => s.length >= 2)
    .slice(0, SYMBOL_MAX);
}

/**
 * Detect languages from file extensions.
 */
export function detectLanguages(files: string[]): string[] {
  const langs = new Set<string>();
  for (const file of files) {
    for (const [re, lang] of LANG_MAP) {
      if (re.test(file)) {
        langs.add(lang);
        break;
      }
    }
  }
  return [...langs];
}
