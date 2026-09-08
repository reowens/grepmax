import { Command } from "commander";
import {
  callGraphVerb,
  type GraphDeadFacts,
  runGraphDead,
} from "../lib/daemon/graph-handler";
import { VectorDB } from "../lib/store/vector-db";
import { symbolNotFoundLines } from "../lib/utils/agent-errors";
import { gracefulExit } from "../lib/utils/exit";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";
import { reportStoreAccessRefusal } from "../lib/utils/store-access";

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
    // Opened only if the daemon is unreachable; withStoreRead decides.
    const local: { db: VectorDB | null } = { db: null };
    try {
      const projectRoot = findProjectRoot(root) ?? root;
      maybeWarnStaleChunker(projectRoot, { agent: opts.agent });
      maybeWarnStaleEmbedding(projectRoot, { agent: opts.agent });

      const { resolveScope } = await import("../lib/utils/scope-filter");
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });

      // The defining chunk plus its inbound callers, counted store-side: the
      // caller set can be large and only its size and top 3 are rendered.
      const facts = await callGraphVerb<GraphDeadFacts>("graph.dead", {
        projectRoot,
        scope,
        payload: { target: symbol },
        render: (resp) => resp.dead as GraphDeadFacts,
        inProcess: () => {
          local.db ??= new VectorDB(ensureProjectPaths(projectRoot).lancedbDir);
          return runGraphDead(local.db, { symbol, scope });
        },
      });

      if (!facts.found) {
        console.log(
          symbolNotFoundLines(symbol, { agent: opts.agent }).join("\n"),
        );
        process.exitCode = 1;
        return;
      }

      const status: Status =
        facts.callerCount === 0
          ? facts.isExported
            ? "PUBLIC_EXPORT"
            : "DEAD"
          : "LIVE";

      const result: DeadResult = {
        status,
        symbol,
        defPath: facts.defPath,
        defLine: facts.defLine,
        callerCount: facts.callerCount,
        topCallers: facts.topCallers,
      };

      console.log(
        opts.agent
          ? formatAgent(result, projectRoot)
          : formatHuman(result, projectRoot),
      );
    } catch (error) {
      // A sandbox refusal is already one actionable line; a "Dead check
      // failed:" prefix would bury the settings key that fixes it.
      if (!reportStoreAccessRefusal(error)) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error("Dead check failed:", message);
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
