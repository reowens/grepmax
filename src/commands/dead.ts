import { Command } from "commander";
import { GraphBuilder, type GraphNode } from "../lib/graph/graph-builder";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { escapeSqlString } from "../lib/utils/filter-builder";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const style = {
  bold: (s: string) => (useColors ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (useColors ? `\x1b[2m${s}\x1b[22m` : s),
  red: (s: string) => (useColors ? `\x1b[31m${s}\x1b[39m` : s),
  yellow: (s: string) => (useColors ? `\x1b[33m${s}\x1b[39m` : s),
  green: (s: string) => (useColors ? `\x1b[32m${s}\x1b[39m` : s),
};

const TOP_CALLERS = 3;

type Status = "DEAD" | "PUBLIC_EXPORT" | "LIVE";

interface DeadResult {
  status: Status;
  symbol: string;
  defPath: string;
  defLine: number;
  callerCount: number;
  topCallers: Array<{ file: string; line: number }>;
}

function statusLabel(status: Status): string {
  switch (status) {
    case "DEAD":
      return "DEAD";
    case "PUBLIC_EXPORT":
      return "PUBLIC EXPORT";
    case "LIVE":
      return "LIVE";
  }
}

function formatHuman(r: DeadResult, projectRoot: string): string {
  const rel = (p: string) =>
    p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p;
  const defLoc = `${rel(r.defPath)}:${r.defLine + 1}`;
  if (r.status === "DEAD") {
    return `${style.red(style.bold("DEAD"))}  ${defLoc} defines ${style.bold(r.symbol)}`;
  }
  if (r.status === "PUBLIC_EXPORT") {
    return `${style.yellow(style.bold("PUBLIC EXPORT"))}  ${defLoc} defines ${style.bold(r.symbol)} ${style.dim("— no internal callers found; check external usage")}`;
  }
  const header = `${style.green(style.bold("LIVE"))}  ${defLoc} defines ${style.bold(r.symbol)} ${style.dim(`— ${r.callerCount} inbound caller${r.callerCount === 1 ? "" : "s"} (top ${Math.min(TOP_CALLERS, r.topCallers.length)}):`)}`;
  const lines = [header];
  for (const c of r.topCallers) {
    lines.push(`  ${rel(c.file)}:${c.line + 1}`);
  }
  return lines.join("\n");
}

function formatAgent(r: DeadResult, projectRoot: string): string {
  const rel = (p: string) =>
    p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p;
  const defLoc = `${rel(r.defPath)}:${r.defLine + 1}`;
  const callerLocs = r.topCallers
    .map((c) => `${rel(c.file)}:${c.line + 1}`)
    .join(",");
  return [
    statusLabel(r.status),
    defLoc,
    String(r.callerCount),
    callerLocs,
  ].join("\t");
}

export const dead = new Command("dead")
  .description(
    "Report whether a symbol has zero inbound callers in the indexed call graph. " +
      "The call graph reflects what tree-sitter chunked — dynamic dispatch, " +
      "reflection, eval, and string-built call sites won't show up, so a 'DEAD' " +
      "result is a hypothesis, not a proof. Exported public-API symbols " +
      "legitimately have no in-project callers (reported as PUBLIC EXPORT).",
  )
  .argument("<symbol>", "The symbol to check")
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
  .option("--agent", "Compact TSV output for AI agents", false)
  .action(async (symbol, opts) => {
    const root = resolveRootOrExit(opts.root);
    if (root === null) return;
    let vectorDb: VectorDB | null = null;
    try {
      const projectRoot = findProjectRoot(root) ?? root;
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

      // Resolve the defining chunk to get path, line, and is_exported.
      const table = await vectorDb.ensureTable();
      const defRows = await table
        .query()
        .select(["path", "start_line", "is_exported"])
        .where(
          buildScopeWhere(
            scope,
            `array_contains(defined_symbols, '${escapeSqlString(symbol)}')`,
          ),
        )
        .limit(1)
        .toArray();

      if (defRows.length === 0) {
        console.log(
          opts.agent ? "(not found)" : `Symbol not found: ${symbol}`,
        );
        process.exitCode = 1;
        return;
      }

      const defRow = defRows[0] as any;
      const defPath = String(defRow.path || "");
      const defLine = Number(defRow.start_line || 0);
      const isExported = Boolean(defRow.is_exported);

      const builder = new GraphBuilder(
        vectorDb,
        scope.pathPrefix,
        scope.excludePrefixes,
      );
      const callers: GraphNode[] = await builder.getCallers(symbol);

      const status: Status =
        callers.length === 0
          ? isExported
            ? "PUBLIC_EXPORT"
            : "DEAD"
          : "LIVE";

      const topCallers = callers
        .slice(0, TOP_CALLERS)
        .map((c) => ({ file: c.file, line: c.line }));

      const result: DeadResult = {
        status,
        symbol,
        defPath,
        defLine,
        callerCount: callers.length,
        topCallers,
      };

      console.log(
        opts.agent
          ? formatAgent(result, projectRoot)
          : formatHuman(result, projectRoot),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Dead check failed:", message);
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
