import * as path from "node:path";
import { Command } from "commander";
import {
  runSymbols,
  type SymbolEntry,
  withLocalStore,
} from "../lib/daemon/rows-handler";
import { sendDaemonCommand } from "../lib/utils/daemon-client";
import { gracefulExit } from "../lib/utils/exit";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  reportStoreAccessRefusal,
  withStoreRead,
} from "../lib/utils/store-access";

const style = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
};

/**
 * Ask the daemon for the symbol table; open the store only when no daemon is
 * listening. Both branches run the same `runSymbols`, so the two paths cannot
 * disagree — only the process the query runs in changes.
 */
async function collectSymbols(options: {
  projectRoot: string;
  limit: number;
  pathPrefix?: string;
  pattern?: string;
}): Promise<SymbolEntry[]> {
  const paths = ensureProjectPaths(options.projectRoot);
  // Resolve to absolute for the centralized index. No trailing slash: the
  // query has always matched starts_with on the bare prefix.
  const absPrefix = options.pathPrefix
    ? path.isAbsolute(options.pathPrefix)
      ? options.pathPrefix
      : path.resolve(options.projectRoot, options.pathPrefix)
    : undefined;

  return withStoreRead<SymbolEntry[]>("symbols", {
    daemon: () =>
      sendDaemonCommand(
        {
          cmd: "rows.symbols",
          projectRoot: options.projectRoot,
          pathPrefix: absPrefix,
          pattern: options.pattern,
          limit: options.limit,
        },
        { timeoutMs: 60_000 },
      ),
    render: (resp) => (resp.entries ?? []) as SymbolEntry[],
    inProcess: () =>
      withLocalStore(paths.lancedbDir, (deps) =>
        runSymbols(deps, {
          projectRoot: options.projectRoot,
          pathPrefix: absPrefix,
          pattern: options.pattern,
          limit: options.limit,
        }),
      ),
    fallbackOnUnknownVerb: true,
  });
}

function formatTable(entries: SymbolEntry[]): string {
  if (entries.length === 0) {
    return [
      "No symbols found.",
      "",
      "Try:",
      "  gmax status   — verify the project is indexed",
      "  gmax index    — rebuild the index",
    ].join("\n");
  }

  const rows = entries.map((e) => ({
    symbol: e.symbol,
    count: e.count.toString(),
    loc: `${e.path}:${Math.max(1, e.line + 1)}`,
  }));

  const headers = { symbol: "Symbol", count: "Count", loc: "Path:Line" };
  const all = [headers, ...rows];
  const widths = {
    symbol: Math.max(...all.map((r) => r.symbol.length)),
    count: Math.max(...all.map((r) => r.count.length)),
    loc: Math.max(...all.map((r) => r.loc.length)),
  };

  const render = (r: (typeof rows)[number]) =>
    `${r.symbol.padEnd(widths.symbol)}  ${r.count
      .padStart(widths.count)
      .padEnd(widths.count + 2)}${r.loc}`;

  const lines = [
    `${style.bold(headers.symbol.padEnd(widths.symbol))}  ${style.bold(
      headers.count.padEnd(widths.count),
    )}  ${style.bold(headers.loc)}`,
    `${"-".repeat(widths.symbol)}  ${"-".repeat(widths.count)}  ${"-".repeat(
      widths.loc,
    )}`,
    ...rows.map(render),
  ];

  return lines.join("\n");
}

function formatAgent(entries: SymbolEntry[], projectRoot: string): string {
  if (entries.length === 0) return "(none)";
  return entries
    .map((e) => {
      const rel = e.path.startsWith(projectRoot)
        ? e.path.slice(projectRoot.length + 1)
        : e.path;
      return `${e.symbol}\t${rel}:${Math.max(1, e.line + 1)}\t${e.count}`;
    })
    .join("\n");
}

export const symbols = new Command("symbols")
  .description("List indexed symbols and where they are defined")
  .argument("[pattern]", "Optional pattern to filter symbols by name")
  .option("-l, --limit <number>", "Max symbols to list (default 20)", "20")
  .option("-p, --path <prefix>", "Only include symbols under this path prefix")
  .option("--root <dir>", "Project root directory")
  .option("--agent", "Compact output for AI agents", false)
  .action(async (pattern, cmd) => {
    const root = resolveRootOrExit(cmd.root);
    if (root === null) return;
    const projectRoot = findProjectRoot(root) ?? root;
    const limit = Number.parseInt(cmd.limit, 10);
    // Auto-scope to project root; --path narrows further within it
    const pathPrefix = cmd.path ?? projectRoot;

    try {
      const entries = await collectSymbols({
        projectRoot,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
        pathPrefix,
        pattern: pattern as string | undefined,
      });

      if (cmd.agent) {
        console.log(formatAgent(entries, projectRoot));
      } else {
        console.log(
          `${style.bold("Project")}: ${style.green(projectRoot)}\n${formatTable(entries)}`,
        );
      }

      if (entries.length === 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      // `symbols` was the one read command with no catch at all, so a denied
      // lease escaped as a raw node:fs stack trace instead of the one-line hint.
      if (!reportStoreAccessRefusal(error)) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("Symbols failed:", msg);
        process.exitCode = 1;
      }
    } finally {
      await gracefulExit();
    }
  });
