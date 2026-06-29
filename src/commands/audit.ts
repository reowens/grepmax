import { Command } from "commander";
import { isBuiltinCallee } from "../lib/graph/callsites";
import { VectorDB } from "../lib/store/vector-db";
import { toArr } from "../lib/utils/arrow";
import { gracefulExit } from "../lib/utils/exit";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

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
  /** Files defining this name. >1 means the attribution (file:line) is a
   * first-definition-wins guess and inbound counts merge all same-name
   * symbols. */
  defFiles: number;
}

interface HubFile {
  file: string;
  dependents: number; // distinct external files depending on this file
  defines: number; // symbols defined here
  fanOut: number; // distinct in-project symbols this file references
}

interface FileCycle {
  files: string[];
  edgeCount: number;
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
  fileCycles: FileCycle[];
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

function findFileCycles(
  deps: Map<string, Set<string>>,
  prefix: string,
  top: number,
): FileCycle[] {
  const indexByFile = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let index = 0;

  const strongConnect = (file: string) => {
    indexByFile.set(file, index);
    lowlink.set(file, index);
    index++;
    stack.push(file);
    onStack.add(file);

    for (const dep of deps.get(file) ?? []) {
      if (!indexByFile.has(dep)) {
        strongConnect(dep);
        lowlink.set(
          file,
          Math.min(lowlink.get(file) ?? 0, lowlink.get(dep) ?? 0),
        );
      } else if (onStack.has(dep)) {
        lowlink.set(
          file,
          Math.min(lowlink.get(file) ?? 0, indexByFile.get(dep) ?? 0),
        );
      }
    }

    if (lowlink.get(file) !== indexByFile.get(file)) return;

    const component: string[] = [];
    while (stack.length > 0) {
      const dep = stack.pop()!;
      onStack.delete(dep);
      component.push(dep);
      if (dep === file) break;
    }
    if (component.length > 1) components.push(component);
  };

  const files = new Set<string>();
  for (const [file, targets] of deps) {
    files.add(file);
    for (const target of targets) files.add(target);
  }
  for (const file of [...files].sort()) {
    if (!indexByFile.has(file)) strongConnect(file);
  }

  return components
    .map((component) => {
      const set = new Set(component);
      let edgeCount = 0;
      for (const file of component) {
        for (const dep of deps.get(file) ?? []) {
          if (set.has(dep)) edgeCount++;
        }
      }
      return {
        files: component.map((f) => rel(f, prefix)).sort(),
        edgeCount,
      };
    })
    .sort(
      (a, b) =>
        b.files.length - a.files.length ||
        b.edgeCount - a.edgeCount ||
        a.files.join("\0").localeCompare(b.files.join("\0")),
    )
    .slice(0, top);
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
  // Distinct files defining each name — name-based edges can't tell same-name
  // symbols apart, so multi-file definitions get flagged in the output.
  const defFileCounts = new Map<string, Set<string>>();
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
      if (!defFileCounts.has(s)) defFileCounts.set(s, new Set());
      defFileCounts.get(s)!.add(file);
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
    // Builtin method names (get, set, push, …) leak in via prototype/member
    // definitions and their inbound counts are meaningless name collisions.
    if (isBuiltinCallee(symbol)) continue;
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
      defFiles: defFileCounts.get(symbol)?.size ?? 1,
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

  const fileDeps = new Map<string, Set<string>>();
  for (const [file, refs] of fileOutRefs) {
    for (const s of refs) {
      if (isBuiltinCallee(s)) continue;
      const defFiles = defFileCounts.get(s);
      if (!defFiles || defFiles.size !== 1) continue;
      const [depFile] = defFiles;
      if (!depFile || depFile === file) continue;
      if (!fileDeps.has(file)) fileDeps.set(file, new Set());
      fileDeps.get(file)!.add(depFile);
    }
  }
  const fileCycles = findFileCycles(fileDeps, prefix, top);

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
    fileCycles,
    deadCandidates: deadAll.slice(0, top),
    deadTotal: deadAll.length,
  };
}

function formatCycle(files: string[]): string {
  const shown =
    files.length > 6
      ? [...files.slice(0, 6), `... ${files.length - 6} more`]
      : files;
  return shown.join(", ");
}

function formatHuman(r: AuditResult): string {
  const out: string[] = [];
  out.push(
    `${style.bold("Audit")} ${style.dim(`— ${r.scannedChunks} chunks across ${r.scannedFiles} files`)}`,
  );

  out.push("");
  out.push(
    style.bold("God nodes") + style.dim(" (most depended-upon symbols)"),
  );
  if (r.godNodes.length === 0) {
    out.push(style.dim("  none"));
  } else {
    for (const g of r.godNodes) {
      const ambiguous =
        g.defFiles > 1
          ? style.dim(`  ~defined in ${g.defFiles} files, location is a guess`)
          : "";
      out.push(
        `  ${style.cyan(g.symbol.padEnd(28))} ${style.dim(`${g.inboundFiles} files`)}, ${g.totalRefs} refs  ${style.dim(`${g.file}:${g.line + 1}`)}${ambiguous}`,
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
    style.bold("File dependency cycles") +
      style.dim(" (symbol-derived, bounded SCCs)"),
  );
  if (r.fileCycles.length === 0) {
    out.push(style.dim("  none"));
  } else {
    for (const c of r.fileCycles) {
      out.push(
        `  ${formatCycle(c.files)}  ${style.dim(`${c.files.length} files, ${c.edgeCount} internal edges`)}`,
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
    const ambiguous = g.defFiles > 1 ? `\tdefs=${g.defFiles}` : "";
    lines.push(
      `god\t${g.symbol}\t${g.file}:${g.line + 1}\t${g.inboundFiles}\t${g.totalRefs}${ambiguous}`,
    );
  }
  for (const h of r.hubFiles) {
    lines.push(`hub\t${h.file}\t${h.dependents}\t${h.defines}\t${h.fanOut}`);
  }
  for (const c of r.fileCycles) {
    lines.push(
      `cycle\t${c.files.join(",")}\t${c.files.length}\t${c.edgeCount}`,
    );
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
          "type_referenced_symbols",
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
          // Union call-position + type-position edges so god-node ranking and
          // dead-candidate detection see references made purely in type position.
          referenced_symbols: [
            ...new Set([
              ...toArr((r as any).referenced_symbols),
              ...toArr((r as any).type_referenced_symbols),
            ]),
          ],
        })),
        prefix,
        top,
      );

      console.log(opts.agent ? formatAgent(result) : formatHuman(result));
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
