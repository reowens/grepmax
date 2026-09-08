import { Command } from "commander";
import {
  type AuditResult,
  callGraphVerb,
  runGraphAudit,
} from "../lib/daemon/graph-handler";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { reportStoreAccessRefusal } from "../lib/utils/store-access";

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const style = {
  bold: (s: string) => (useColors ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (useColors ? `\x1b[2m${s}\x1b[39m` : s),
  red: (s: string) => (useColors ? `\x1b[31m${s}\x1b[39m` : s),
  yellow: (s: string) => (useColors ? `\x1b[33m${s}\x1b[39m` : s),
  cyan: (s: string) => (useColors ? `\x1b[36m${s}\x1b[39m` : s),
};

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
    "Graph-summary of the indexed project: god nodes (most depended-upon " +
      "symbols), hub files (most depended-upon files), symbol-derived file " +
      "dependency cycles, and dead-code candidates (non-exported symbols with " +
      "zero inbound references). One pass over the static reference graph; " +
      "dynamic dispatch / reflection / eval are invisible, so dead candidates " +
      "are hypotheses, not proof.",
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
    // Opened only if the daemon is unreachable; withStoreRead decides.
    const local: { db: VectorDB | null } = { db: null };
    try {
      const projectRoot = findProjectRoot(root) ?? root;

      const { resolveScope } = await import("../lib/utils/scope-filter");
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });

      const top = Math.max(1, Number.parseInt(opts.top, 10) || 10);

      // Up to 500k rows are read and aggregated wherever the store is open;
      // what crosses the socket is the finished report.
      const result = await callGraphVerb<AuditResult | null>("graph.audit", {
        projectRoot,
        scope,
        payload: { top },
        render: (resp) => (resp.audit as AuditResult | null) ?? null,
        inProcess: () => {
          local.db ??= new VectorDB(ensureProjectPaths(projectRoot).lancedbDir);
          return runGraphAudit(local.db, { projectRoot, scope, top });
        },
      });

      if (result === null) {
        console.log(
          opts.agent
            ? "(no indexed data)"
            : `No indexed data for ${projectRoot}. Run: gmax index --path ${projectRoot}`,
        );
        process.exitCode = 1;
        return;
      }

      console.log(opts.agent ? formatAgent(result) : formatHuman(result));
    } catch (error) {
      // A sandbox refusal is already one actionable line; an "Audit failed:"
      // prefix would bury the settings key that fixes it.
      if (!reportStoreAccessRefusal(error)) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error("Audit failed:", message);
        process.exitCode = 1;
      }
    } finally {
      if (local.db) {
        try {
          await local.db.close();
        } catch (err) {
          console.error("Failed to close VectorDB:", err);
        }
      }
      await gracefulExit();
    }
  });
