/**
 * Format inline summary comments for skeleton bodies.
 *
 * Output format: "// → call1, call2, call3 | C:8 | ORCH"
 * - Shows referenced symbols (what the function calls)
 * - Shows complexity score
 * - Shows ORCH role only (the interesting one)
 */

export interface ChunkMetadata {
  referencedSymbols?: string[];
  complexity?: number;
  role?: string;
}

export interface SummaryOptions {
  /** Maximum number of calls to show before truncating */
  maxCalls?: number;
  /** Whether to show complexity */
  showComplexity?: boolean;
  /** Whether to show role (only ORCH is shown) */
  showRole?: boolean;
  /** Comment style for the language */
  commentStyle?: "slash" | "hash" | "dash";
}

const DEFAULT_OPTIONS: Required<SummaryOptions> = {
  maxCalls: 4,
  showComplexity: true,
  showRole: true,
  commentStyle: "slash",
};

/**
 * Format the inline summary comment for a function body.
 *
 * @example
 * // Input: { referencedSymbols: ['findByEmail', 'compare', 'sign'], complexity: 8, role: 'ORCHESTRATION' }
 * // Output: "// → findByEmail, compare, sign | C:8 | ORCH"
 */
export function formatSummary(
  metadata: ChunkMetadata,
  options: SummaryOptions = {},
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const parts: string[] = [];

  // Calls (referenced symbols)
  if (metadata.referencedSymbols?.length) {
    const calls = metadata.referencedSymbols.slice(0, opts.maxCalls);
    if (metadata.referencedSymbols.length > opts.maxCalls) {
      calls.push("...");
    }
    parts.push(`→ ${calls.join(", ")}`);
  }

  // Complexity (only if > 1, trivial functions don't need it)
  if (opts.showComplexity && metadata.complexity && metadata.complexity > 1) {
    parts.push(`C:${metadata.complexity}`);
  }

  // Role (only show ORCH - it's the architecturally interesting one)
  if (opts.showRole && metadata.role === "ORCHESTRATION") {
    parts.push("ORCH");
  }

  // Build the comment
  const commentPrefix = getCommentPrefix(opts.commentStyle);

  if (parts.length === 0) {
    return `${commentPrefix} ...`;
  }

  return `${commentPrefix} ${parts.join(" | ")}`;
}

/**
 * Get the single-line comment prefix for a language style.
 */
function getCommentPrefix(style: "slash" | "hash" | "dash"): string {
  switch (style) {
    case "hash":
      return "#";
    case "dash":
      return "--";
    case "slash":
    default:
      return "//";
  }
}

/**
 * Get the appropriate comment style for a language.
 */
export function getCommentStyle(langId: string): "slash" | "hash" | "dash" {
  switch (langId) {
    case "python":
    case "ruby":
    case "bash":
      return "hash";
    case "sql":
    case "lua":
      return "dash";
    default:
      return "slash";
  }
}

/**
 * Format the skeleton file header comment.
 */
export function formatSkeletonHeader(
  filePath: string,
  tokenEstimate: number,
): string {
  return `// ${filePath} (skeleton, ~${tokenEstimate} tokens)`;
}
