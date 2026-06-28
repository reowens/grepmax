import * as path from "node:path";
import type { ChunkType, FileMetadata, SearchResponse } from "../store/types";
import type { TextResult } from "../utils/formatter";

export function toTextResults(data: SearchResponse["data"]): TextResult[] {
  return data.map((r) => {
    const rawPath =
      typeof (r.metadata as FileMetadata | undefined)?.path === "string"
        ? ((r.metadata as FileMetadata).path as string)
        : "Unknown path";

    const start =
      typeof r.generated_metadata?.start_line === "number"
        ? r.generated_metadata.start_line
        : 0;
    const end =
      typeof r.generated_metadata?.end_line === "number"
        ? r.generated_metadata.end_line
        : start + Math.max(0, (r.generated_metadata?.num_lines ?? 1) - 1);

    return {
      path: rawPath,
      score: r.score,
      content: r.text || "",
      chunk_type: r.generated_metadata?.type,
      start_line: start,
      end_line: end,
    };
  });
}

export type CompactHit = {
  path: string;
  range: string;
  start_line: number;
  end_line: number;
  role?: string;
  confidence?: string;
  score?: number;
  defined?: string[];
  preview?: string;
  summary?: string;
};

function getPreviewText(chunk: ChunkType): string {
  const maxLen = 140;
  const lines =
    chunk.text
      ?.split("\n")
      .map((l) => l.trim())
      .filter(Boolean) ?? [];
  let preview = lines[0] ?? "";

  if (!preview && chunk.defined_symbols?.length) {
    preview = chunk.defined_symbols[0] ?? "";
  }

  if (preview.length > maxLen) {
    preview = `${preview.slice(0, maxLen)}...`;
  }
  return preview;
}

export function toCompactHits(data: SearchResponse["data"]): CompactHit[] {
  return data.map((chunk) => {
    const rawPath =
      typeof (chunk.metadata as FileMetadata | undefined)?.path === "string"
        ? ((chunk.metadata as FileMetadata).path as string)
        : "Unknown path";

    const start =
      typeof chunk.generated_metadata?.start_line === "number"
        ? chunk.generated_metadata.start_line
        : 0;
    const end =
      typeof chunk.generated_metadata?.end_line === "number"
        ? chunk.generated_metadata.end_line
        : start + Math.max(0, (chunk.generated_metadata?.num_lines ?? 1) - 1);

    return {
      path: rawPath,
      range: `${start + 1}-${end + 1}`,
      start_line: start,
      end_line: end,
      role: chunk.role,
      confidence: chunk.confidence,
      score: chunk.score,
      defined: Array.isArray(chunk.defined_symbols)
        ? chunk.defined_symbols.slice(0, 3)
        : typeof chunk.defined_symbols === "string"
          ? [chunk.defined_symbols]
          : typeof (chunk.defined_symbols as any)?.toArray === "function"
            ? ((chunk.defined_symbols as any).toArray() as string[]).slice(0, 3)
            : [],
      preview: getPreviewText(chunk),
      summary: typeof chunk.summary === "string" ? chunk.summary : undefined,
    };
  });
}

function compactRole(role?: string): string {
  if (!role) return "UNK";
  if (role.startsWith("ORCH")) return "ORCH";
  if (role.startsWith("DEF")) return "DEF";
  if (role.startsWith("IMP")) return "IMPL";
  return role.slice(0, 4).toUpperCase();
}

function compactConf(conf?: string): string {
  if (!conf) return "U";
  const c = conf.toUpperCase();
  if (c.startsWith("H")) return "H";
  if (c.startsWith("M")) return "M";
  if (c.startsWith("L")) return "L";
  return "U";
}

function compactScore(score?: number): string {
  if (typeof score !== "number") return "";
  const fixed = score.toFixed(3);
  return fixed
    .replace(/^0\./, ".")
    .replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m));
}

function truncateEnd(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return `${s.slice(0, max - 3)}...`;
}

function padR(s: string, w: number) {
  const n = Math.max(0, w - s.length);
  return s + " ".repeat(n);
}
function padL(s: string, w: number) {
  const n = Math.max(0, w - s.length);
  return " ".repeat(n) + s;
}

function formatCompactTSV(
  hits: CompactHit[],
  projectRoot: string,
  query: string,
): string {
  if (!hits.length) return "No matches found.";
  const lines: string[] = [];
  lines.push(`gmax hits\tquery=${query}\tcount=${hits.length}`);
  lines.push("path\tlines\tscore\trole\tconf\tdefined\tsummary");

  for (const hit of hits) {
    const relPath = path.isAbsolute(hit.path)
      ? path.relative(projectRoot, hit.path)
      : hit.path;
    const score = compactScore(hit.score);
    const role = compactRole(hit.role);
    const conf = compactConf(hit.confidence);
    const defs = (hit.defined ?? []).join(",");
    const summary = hit.summary ?? "";
    lines.push(
      [relPath, hit.range, score, role, conf, defs, summary].join("\t"),
    );
  }
  return lines.join("\n");
}

function formatCompactPretty(
  hits: CompactHit[],
  projectRoot: string,
  query: string,
  termWidth: number,
  useAnsi: boolean,
): string {
  if (!hits.length) return "No matches found.";

  const dim = (s: string) => (useAnsi ? `\x1b[90m${s}\x1b[0m` : s);
  const bold = (s: string) => (useAnsi ? `\x1b[1m${s}\x1b[0m` : s);

  const wLines = 9;
  const wScore = 6;
  const wRole = 4;
  const wConf = 1;
  const wDef = 20;

  const gutters = 5;
  const fixed = wLines + wScore + wRole + wConf + wDef + gutters;

  const wPath = Math.max(24, Math.min(64, termWidth - fixed));

  const header = `gmax hits  count=${hits.length}  query="${query}"`;

  const cols = [
    padR("path", wPath),
    padR("lines", wLines),
    padL("score", wScore),
    padR("role", wRole),
    padR("c", wConf),
    padR("defined", wDef),
  ].join(" ");

  const out: string[] = [];
  out.push(bold(header));
  out.push(dim(cols));

  for (const hit of hits) {
    const relPath = path.isAbsolute(hit.path)
      ? path.relative(projectRoot, hit.path)
      : hit.path;
    const score = compactScore(hit.score);
    const role = compactRole(hit.role);
    const conf = compactConf(hit.confidence);
    const defs = (hit.defined ?? []).join(",") || "-";
    const displayPath = `${relPath}:${hit.start_line + 1}`;
    const paddedPath = padR(displayPath, wPath);

    const row = [
      paddedPath,
      padR(hit.range, wLines),
      padL(score || "", wScore),
      padR(role, wRole),
      padR(conf, wConf),
      padR(truncateEnd(defs, wDef), wDef),
    ].join(" ");

    out.push(row);
  }

  return out.join("\n");
}

export function formatCompactTable(
  hits: CompactHit[],
  projectRoot: string,
  query: string,
  opts: { isTTY: boolean; plain: boolean },
): string {
  if (!hits.length) return "No matches found.";

  if (!opts.isTTY || opts.plain) {
    return formatCompactTSV(hits, projectRoot, query);
  }

  const termWidth = Math.max(80, process.stdout.columns ?? 120);
  return formatCompactPretty(hits, projectRoot, query, termWidth, true);
}

export function resultCountHeader(results: any[], maxCount: number): string {
  const files = new Set<string>();
  for (const r of results) {
    const p = (r as any).path ?? (r as any).metadata?.path ?? "";
    if (p) files.add(p);
  }
  const showing =
    results.length < maxCount ? `${results.length}` : `top ${results.length}`;
  return `Found ${results.length} match${results.length === 1 ? "" : "es"} (showing ${showing}) across ${files.size} file${files.size === 1 ? "" : "s"}`;
}
