import { Command } from "commander";
import { toArr } from "../lib/utils/arrow";
import { gracefulExit } from "../lib/utils/exit";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { VectorDB } from "../lib/store/vector-db";

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const style = {
  bold: (s: string) => (useColors ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (useColors ? `\x1b[2m${s}\x1b[39m` : s),
  red: (s: string) => (useColors ? `\x1b[31m${s}\x1b[39m` : s),
  yellow: (s: string) => (useColors ? `\x1b[33m${s}\x1b[39m` : s),
  cyan: (s: string) => (useColors ? `\x1b[36m${s}\x1b[39m` : s),
};

interface DefInfo {
  file: string;
  line: number;
  exported: boolean;
  complexity: number;
}

interface GodNode {
  symbol: string;
  file: string;
  line: number;
  inboundFiles: number;
  totalRefs: number;
}

interface HubFile {
  file: string;
  dependents: number; // distinct external files depending on this file
  defines: number; // symbols defined here
  fanOut: number; // distinct in-project symbols this file references
}

interface DeadCandidate {
  symbol: string;
  file: string;
  line: number;
}

interface AuditResult {
  scannedChunks: number;
  scannedFiles: number;
  godNodes: GodNode[];
  hubFiles: HubFile[];
  deadCandidates: DeadCandidate[];
  deadTotal: number;
}

/** Minimal row shape the aggregator needs (a subset of the chunk record). */
export interface AuditRow {
  path: string;
  start_line: number;
  is_exported: boolean;
  defined_symbols: string[];
  referenced_symbols: string[];
}

// Names too generic to be useful as god-node signal (`id`, `el`, `fn`, …).
const MIN_GOD_NAME_LEN = 3;

function rel(p: string, prefix: string): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * Pure aggregation over chunk rows — no DB, no I/O. Builds the symbol→def map,
 * cross-file inbound edges, and per-file fan-in/out, then derives god nodes
 * (most depended-upon symbols), hub files (most depended-upon files), and
 * dead-code candidates (non-exported symbols with zero inbound references).
 * `top` caps each list; `deadTotal` reports the full pre-cap dead count.
 */
export function computeAudit(
  rows: AuditRow[],
  prefix: string,
  top: number,
): AuditResult {
  // First definition of a symbol wins (matches GraphBuilder semantics).
  const defs = new Map<string, DefInfo>();
  // Distinct files that reference a symbol (cross-file inbound edges).
  const inboundFiles = new Map<string, Set<string>>();
  const inboundTotal = new Map<string, number>();
  // Per-file aggregates.
  const fileDefs = new Map<string, Set<string>>();
  const fileOutRefs = new Map<string, Set<string>>();
  const files = new Set<string>();

  for (const row of rows) {
    const file = String(row.path || "");
    const line = Number(row.start_line || 0);
    const exported = Boolean(row.is_exported);
    const defSyms = toArr(row.defined_symbols);
    const refSyms = toArr(row.referenced_symbols);
    files.add(file);

    for (const s of defSyms) {
      if (!defs.has(s)) {
        defs.set(s, { file, line, exported, complexity: 0 });
      }
      if (!fileDefs.has(file)) fileDefs.set(file, new Set());
      fileDefs.get(file)!.add(s);
    }
    for (const s of refSyms) {
      if (!inboundFiles.has(s)) inboundFiles.set(s, new Set());
      inboundFiles.get(s)!.add(file);
      inboundTotal.set(s, (inboundTotal.get(s) || 0) + 1);
      if (!fileOutRefs.has(file)) fileOutRefs.set(file, new Set());
      fileOutRefs.get(file)!.add(s);
    }
  }

  // God nodes — in-project symbols by distinct external inbound files.
  const godNodes: GodNode[] = [];
  for (const [symbol, info] of defs) {
    if (symbol.length < MIN_GOD_NAME_LEN) continue;
    const refFiles = inboundFiles.get(symbol);
    if (!refFiles) continue;
    let external = 0;
    for (const f of refFiles) if (f !== info.file) external++;
    if (external === 0) continue;
    godNodes.push({
      symbol,
      file: rel(info.file, prefix),
      line: info.line,
      inboundFiles: external,
      totalRefs: inboundTotal.get(symbol) || 0,
    });
  }
  godNodes.sort(
    (a, b) => b.inboundFiles - a.inboundFiles || b.totalRefs - a.totalRefs,
  );

  // Hub files — distinct external files depending on each file (a file G
  // depends on F if G references any symbol F defines).
  const hubFiles: HubFile[] = [];
  for (const [file, syms] of fileDefs) {
    const dependents = new Set<string>();
    for (const s of syms) {
      const refFiles = inboundFiles.get(s);
      if (!refFiles) continue;
      for (const f of refFiles) if (f !== file) dependents.add(f);
    }
    // Fan-out: distinct referenced symbols that are defined somewhere
    // in-project (external-library calls don't count as coupling).
    let fanOut = 0;
    const out = fileOutRefs.get(file);
    if (out) for (const s of out) if (defs.has(s)) fanOut++;
    hubFiles.push({
      file: rel(file, prefix),
      dependents: dependents.size,
      defines: syms.size,
      fanOut,
    });
  }
  hubFiles.sort((a, b) => b.dependents - a.dependents || b.defines - a.defines);

  // Dead candidates — non-exported in-project symbols with zero inbound
  // references anywhere (including their own file).
  const deadAll: DeadCandidate[] = [];
  for (const [symbol, info] of defs) {
    if (info.exported) continue;
    if ((inboundTotal.get(symbol) || 0) > 0) continue;
    deadAll.push({ symbol, file: rel(info.file, prefix), line: info.line });
  }
  deadAll.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    scannedChunks: rows.length,
    scannedFiles: files.size,
    godNodes: godNodes.slice(0, top),
    hubFiles: hubFiles.filter((h) => h.dependents > 0).slice(0, top),
    deadCandidates: deadAll.slice(0, top),
    deadTotal: deadAll.length,
  };
}

function formatHuman(r: AuditResult): string {
  const out: string[] = [];
  out.push(
    `${style.bold("Audit")} ${style.dim(`— ${r.scannedChunks} chunks across ${r.scannedFiles} files`)}`,
  );

  out.push("");
  out.push(style.bold("God nodes") + style.dim(" (most depended-upon symbols)"));
  if (r.godNodes.length === 0) {
    out.push(style.dim("  none"));
  } else {
    for (const g of r.godNodes) {
      out.push(
        `  ${style.cyan(g.symbol.padEnd(28))} ${style.dim(`${g.inboundFiles} files`)}, ${g.totalRefs} refs  ${style.dim(`${g.file}:${g.line + 1}`)}`,
      );
    }
  }

  out.push("");
  out.push(style.bold("Hub files") + style.dim(" (most depended-upon files)"));
  if (r.hubFiles.length === 0) {
    out.push(style.dim("  none"));
  } else {
    for (const h of r.hubFiles) {
      out.push(
        `  ${h.file.padEnd(44)} ${style.dim(`${h.dependents} dependents, ${h.defines} defs, fan-out ${h.fanOut}`)}`,
      );
    }
  }

  out.push("");
  out.push(
    style.bold("Dead-code candidates") +
      style.dim(
        ` (${r.deadTotal} non-exported symbols with zero inbound refs)`,
      ),
  );
  if (r.deadCandidates.length === 0) {
    out.push(style.dim("  none"));
  } else {
    for (const d of r.deadCandidates) {
      out.push(
        `  ${style.red(d.symbol.padEnd(28))} ${style.dim(`${d.file}:${d.line + 1}`)}`,
      );
    }
    if (r.deadTotal > r.deadCandidates.length) {
      out.push(
        style.dim(`  … and ${r.deadTotal - r.deadCandidates.length} more`),
      );
    }
  }

  out.push("");
  out.push(
    style.dim(
      "Static call graph: dynamic dispatch, reflection, eval, and string-built " +
        "call sites are invisible. Dead candidates are hypotheses — verify with " +
        "`gmax dead <symbol>` and `grep` before removing.",
    ),
  );
  return out.join("\n");
}

function formatAgent(r: AuditResult): string {
  const lines: string[] = [];
  lines.push(`scanned\t${r.scannedChunks}\t${r.scannedFiles}`);
  for (const g of r.godNodes) {
    lines.push(
      `god\t${g.symbol}\t${g.file}:${g.line + 1}\t${g.inboundFiles}\t${g.totalRefs}`,
    );
  }
  for (const h of r.hubFiles) {
    lines.push(`hub\t${h.file}\t${h.dependents}\t${h.defines}\t${h.fanOut}`);
  }
  for (const d of r.deadCandidates) {
    lines.push(`dead\t${d.symbol}\t${d.file}:${d.line + 1}`);
  }
  lines.push(`dead_total\t${r.deadTotal}`);
  return lines.join("\n");
}

export const audit = new Command("audit")
  .description(
    "Graph-summary of the indexed project — god nodes (most depended-upon " +
      "symbols), hub files (most depended-upon files), and dead-code candidates " +
      "(non-exported symbols with zero inbound references). One pass over the " +
      "static call graph; dynamic dispatch / reflection / eval are invisible, so " +
      "dead candidates are hypotheses, not proof.",
  )
  .option("--root <dir>", "Project root directory")
  .option(
    "--in <subpath>",
    "Restrict to a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option(
    "--exclude <subpath>",
    "Exclude a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option("--top <n>", "How many of each category to show", "10")
  .option("--agent", "Compact TSV output for AI agents", false)
  .action(async (opts) => {
    const root = resolveRootOrExit(opts.root);
    if (root === null) return;
    let vectorDb: VectorDB | null = null;
    try {
      const projectRoot = findProjectRoot(root) ?? root;
      const prefix = projectRoot.endsWith("/")
        ? projectRoot
        : `${projectRoot}/`;
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      const { resolveScope, buildScopeWhere } = await import(
        "../lib/utils/scope-filter"
      );
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });

      const top = Math.max(1, Number.parseInt(opts.top, 10) || 10);

      const table = await vectorDb.ensureTable();
      const rows = await table
        .query()
        .select([
          "path",
          "start_line",
          "defined_symbols",
          "referenced_symbols",
          "is_exported",
        ])
        .where(buildScopeWhere(scope))
        .limit(500000)
        .toArray();

      if (rows.length === 0) {
        console.log(
          opts.agent
            ? "(no indexed data)"
            : `No indexed data for ${projectRoot}. Run: gmax index --path ${projectRoot}`,
        );
        process.exitCode = 1;
        return;
      }

      const result = computeAudit(
        rows.map((r) => ({
          path: String((r as any).path || ""),
          start_line: Number((r as any).start_line || 0),
          is_exported: Boolean((r as any).is_exported),
          defined_symbols: toArr((r as any).defined_symbols),
          referenced_symbols: toArr((r as any).referenced_symbols),
        })),
        prefix,
        top,
      );

      console.log(
        opts.agent ? formatAgent(result) : formatHuman(result),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Audit failed:", message);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch (err) {
          console.error("Failed to close VectorDB:", err);
        }
      }
      await gracefulExit();
    }
  });
