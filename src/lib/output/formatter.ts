import * as path from "node:path";
import { highlight } from "cli-highlight";
import { getLanguageByExtension } from "../core/languages";
import type { ChunkType, FileMetadata } from "../store/types";

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;

const style = {
  bold: (s: string) => (useColors ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (useColors ? `\x1b[2m${s}\x1b[22m` : s),
  green: (s: string) => (useColors ? `\x1b[32m${s}\x1b[39m` : s),
  blue: (s: string) => (useColors ? `\x1b[34m${s}\x1b[39m` : s),
  cyan: (s: string) => (useColors ? `\x1b[36m${s}\x1b[39m` : s),
  gray: (s: string) => (useColors ? `\x1b[90m${s}\x1b[39m` : s),
};

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath);
  const lang = getLanguageByExtension(ext);
  return lang?.id || "plaintext";
}

function formatScore(score?: number): string {
  if (typeof score !== "number") return "";
  const fixed = score.toFixed(3);
  return fixed
    .replace(/^0\./, ".")
    .replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m));
}

export function formatResult(
  result: ChunkType,
  root: string,
  options: { content?: boolean; explain?: boolean } = {},
): string {
  const metadata = result.metadata as FileMetadata;
  const relPath = path.relative(root, metadata.path);
  const line = result.generated_metadata?.start_line || 0;

  // Header: Role + File + Location
  const role = result.role || "IMPLEMENTATION";
  const roleColor =
    role === "DEFINITION"
      ? style.green
      : role === "ORCHESTRATION"
        ? style.cyan
        : style.blue;

  const header = `${roleColor(role)} ${style.gray(relPath)}:${line}`;

  // Breadcrumb
  const breadcrumb = result.context
    ?.filter((c: string) => !c.startsWith("File:"))
    .join(" > ");
  const breadcrumbLine = breadcrumb ? `\n${style.dim(breadcrumb)}` : "";

  // Context: What defines this, what it calls
  const context: string[] = [];
  if (
    Array.isArray(result.defined_symbols) &&
    result.defined_symbols.length > 0
  ) {
    context.push(`Defines: ${result.defined_symbols.join(", ")}`);
  }
  if (
    Array.isArray(result.referenced_symbols) &&
    result.referenced_symbols.length > 0
  ) {
    context.push(
      `Calls: ${result.referenced_symbols.slice(0, 3).join(", ")}${result.referenced_symbols.length > 3 ? "..." : ""}`,
    );
  }
  // Add score if available
  const scoreStr = formatScore(result.score);
  if (scoreStr) {
    context.push(`Score: ${scoreStr}`);
  }
  const contextLine =
    context.length > 0 ? `\n${style.gray(context.join(" | "))}` : "";

  // Code snippet
  let code = result.text || "";
  // Clean up noise
  code = code
    .split("\n")
    .filter((l) => !l.startsWith("// File:") && !l.startsWith("File:"))
    .join("\n")
    .trim();

  if (!options.content && code.split("\n").length > 15) {
    const lines = code.split("\n");
    code = [...lines.slice(0, 15), style.dim(`...`)].join("\n");
  }

  try {
    const lang = detectLanguage(metadata.path);
    code = highlight(code, { language: lang, ignoreIllegals: true });
  } catch {
    // ignore
  }

  // Explain line
  let explainLine = "";
  if (options.explain && result.scoreBreakdown) {
    const b = result.scoreBreakdown;
    explainLine = `\n${style.dim(`  Scoring: rerank=${b.rerank.toFixed(3)}  fused=${b.fused.toFixed(3)}  boost=${b.boost.toFixed(2)}x  final=${b.normalized.toFixed(3)}`)}`;
  }

  return `
${header}${breadcrumbLine}${contextLine}${explainLine}

${code}

${style.dim("─".repeat(80))}
`.trim();
}

export function formatResults(
  results: ChunkType[],
  root: string,
  options: { content?: boolean; explain?: boolean } = {},
): string {
  if (results.length === 0) return "No results found.";
  return results.map((r) => formatResult(r, root, options)).join("\n\n");
}

import type { CallerTree, GraphNode } from "../graph/graph-builder";

export function formatTrace(
  graph: {
    center: GraphNode | null;
    callerTree: CallerTree[];
    callees: GraphNode[];
    importers: string[];
  },
  options?: { symbol?: string },
): string {
  if (!graph.center) {
    const name = options?.symbol ?? "unknown";
    const lines = [
      `Symbol not found: ${style.bold(name)}`,
      "",
      style.dim("Possible reasons:"),
      style.dim("  • The symbol doesn't exist in any indexed project"),
      style.dim("  • The containing file hasn't been indexed yet"),
      style.dim("  • The name is spelled differently in the source"),
      "",
      style.dim("Try:"),
      style.dim("  gmax status          — see which projects are indexed"),
      style.dim("  gmax search <name>   — fuzzy search for similar symbols"),
    ];
    return lines.join("\n");
  }

  const lines: string[] = [];

  // 1. Importers
  if (graph.importers.length > 0) {
    const filtered = graph.importers.filter(
      (p) => p !== graph.center!.file,
    );
    if (filtered.length > 0) {
      lines.push(style.bold("Imported by:"));
      for (const imp of filtered.slice(0, 10)) {
        lines.push(`  ${style.dim(imp)}`);
      }
      lines.push("");
    }
  }

  // 2. Callers (Upstream, recursive tree)
  function renderCallerTree(trees: CallerTree[], depth: number): void {
    for (const t of trees) {
      const pad = "  ".repeat(depth);
      lines.push(
        `${pad}${style.blue("↑")} ${style.green(t.node.symbol)} ${style.dim(`(${t.node.file}:${t.node.line})`)}`,
      );
      renderCallerTree(t.callers, depth + 1);
    }
  }

  if (graph.callerTree.length > 0) {
    lines.push(style.bold("Callers (Who calls this?):"));
    renderCallerTree(graph.callerTree, 1);
    lines.push("");
  } else {
    lines.push(style.dim("No known callers."));
    lines.push("");
  }

  // 3. Center (The Symbol)
  lines.push(style.bold(`▶ ${graph.center.symbol}`));
  lines.push(
    `  ${style.dim(`Defined in ${graph.center.file}:${graph.center.line}`)}`,
  );
  lines.push(`  ${style.dim(`Role: ${graph.center.role}`)}`);
  lines.push("");

  // 4. Callees (Downstream)
  if (graph.callees.length > 0) {
    lines.push(style.bold("Callees (What does this call?):"));
    graph.callees.forEach((callee) => {
      if (callee.file) {
        lines.push(
          `  ${style.cyan("↓")} ${style.green(callee.symbol)} ${style.dim(`(${callee.file}:${callee.line})`)}`,
        );
      } else {
        lines.push(
          `  ${style.cyan("↓")} ${callee.symbol} ${style.dim("(not indexed)")}`,
        );
      }
    });
  } else {
    lines.push(style.dim("No known callees."));
  }

  return lines.join("\n");
}
