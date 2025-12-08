import { Command } from "commander";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { escapeSqlString, normalizePath } from "../lib/utils/filter-builder";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

const style = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
};

type SymbolEntry = {
  symbol: string;
  count: number;
  path: string;
  line: number;
};

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v) => typeof v === "string");
  if (val && typeof (val as any).toArray === "function") {
    try {
      const arr = (val as any).toArray();
      return Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function collectSymbols(options: {
  projectRoot: string;
  limit: number;
  pathPrefix?: string;
  pattern?: string;
}): Promise<SymbolEntry[]> {
  const paths = ensureProjectPaths(options.projectRoot);
  const db = new VectorDB(paths.lancedbDir);

  try {
    const table = await db.ensureTable();

    let query = table
      .query()
      .select(["defined_symbols", "path", "start_line"])
      .where("array_length(defined_symbols) > 0")
      // Fetch more rows to ensure we have enough after filtering/aggregation
      .limit(options.pattern ? 10000 : Math.max(options.limit * 50, 2000));

    if (options.pathPrefix) {
      query = query.where(
        `path LIKE '${escapeSqlString(normalizePath(options.pathPrefix))}%'`,
      );
    }

    const rows = await query.toArray();

    const map = new Map<string, SymbolEntry>();
    for (const row of rows) {
      const defs = toStringArray((row as any).defined_symbols);
      const path = String((row as any).path || "");
      const line = Number((row as any).start_line || 0);
      for (const sym of defs) {
        if (
          options.pattern &&
          !sym.toLowerCase().includes(options.pattern.toLowerCase())
        ) {
          continue;
        }
        const existing = map.get(sym);
        if (existing) {
          existing.count += 1;
        } else {
          map.set(sym, { symbol: sym, count: 1, path, line });
        }
      }
    }

    return Array.from(map.values())
      .sort((a, b) => {
        // Sort by count desc, then symbol asc
        if (b.count !== a.count) return b.count - a.count;
        return a.symbol.localeCompare(b.symbol);
      })
      .slice(0, options.limit);
  } finally {
    await db.close();
  }
}

function formatTable(entries: SymbolEntry[]): string {
  if (entries.length === 0) {
    return "No symbols found. Run `osgrep index` to build the index.";
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

export const symbols = new Command("symbols")
  .description("List indexed symbols and where they are defined")
  .argument("[pattern]", "Optional pattern to filter symbols by name")
  .option("-l, --limit <number>", "Max symbols to list (default 20)", "20")
  .option("-p, --path <prefix>", "Only include symbols under this path prefix")
  .action(async (pattern, cmd) => {
    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
    const limit = Number.parseInt(cmd.limit, 10);
    const entries = await collectSymbols({
      projectRoot,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
      pathPrefix: cmd.path as string | undefined,
      pattern: pattern as string | undefined,
    });

    console.log(
      `${style.bold("Project")}: ${style.green(projectRoot)}\n${formatTable(entries)}`,
    );

    await gracefulExit();
  });
