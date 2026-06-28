import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { escapeSqlString } from "../lib/utils/filter-builder";
import { type Commit, getCommitHistory } from "../lib/utils/git";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const style = {
  bold: (s: string) => (useColors ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (useColors ? `\x1b[2m${s}\x1b[22m` : s),
  cyan: (s: string) => (useColors ? `\x1b[36m${s}\x1b[39m` : s),
  yellow: (s: string) => (useColors ? `\x1b[33m${s}\x1b[39m` : s),
};

function relativize(p: string, projectRoot: string): string {
  const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

async function resolveSymbolPaths(
  vectorDb: VectorDB,
  symbol: string,
  projectRoot: string,
  inOpt: string[] | undefined,
  excludeOpt: string[] | undefined,
): Promise<string[]> {
  const { resolveScope, buildScopeWhere } = await import(
    "../lib/utils/scope-filter"
  );
  const scope = resolveScope({
    projectRoot,
    in: inOpt,
    exclude: excludeOpt,
  });
  const where = buildScopeWhere(
    scope,
    `array_contains(defined_symbols, '${escapeSqlString(symbol)}')`,
  );
  const table = await vectorDb.ensureTable();
  const rows = await table
    .query()
    .select(["path"])
    .where(where)
    .limit(50)
    .toArray();
  const paths = new Set<string>();
  for (const row of rows) {
    const p = String((row as any).path || "");
    if (p) paths.add(p);
  }
  return [...paths];
}

function printHuman(
  commits: Commit[],
  projectRoot: string,
  targetPaths: string[] | null,
): void {
  for (const c of commits) {
    const header = `${style.yellow(c.shortHash)}  ${c.author}  ${style.dim(c.relDate)}  ${style.bold(c.subject)}`;
    console.log(header);
    const stat = `${c.filesChanged} file${c.filesChanged === 1 ? "" : "s"} changed, +${c.insertions} / -${c.deletions}`;
    console.log(`  ${style.dim(stat)}`);
    if (targetPaths && targetPaths.length > 1) {
      const targetSet = new Set(targetPaths);
      const touched = c.numstatLines
        .filter(
          (n) =>
            targetSet.has(n.path) ||
            targetSet.has(path.resolve(projectRoot, n.path)),
        )
        .map((n) => relativize(n.path, projectRoot));
      if (touched.length > 0) {
        console.log(`  ${style.dim(`via: ${touched.join(", ")}`)}`);
      }
    }
    console.log();
  }
}

function printAgent(
  commits: Commit[],
  projectRoot: string,
  targetPaths: string[] | null,
): void {
  const targetSet =
    targetPaths && targetPaths.length > 0 ? new Set(targetPaths) : null;
  for (const c of commits) {
    let touched = "";
    if (targetSet) {
      const touchedPaths = c.numstatLines
        .filter(
          (n) =>
            targetSet.has(n.path) ||
            targetSet.has(path.resolve(projectRoot, n.path)),
        )
        .map((n) => relativize(n.path, projectRoot));
      touched = touchedPaths.join(",");
    }
    const subject = c.subject.replace(/\t/g, " ");
    console.log(
      `${c.shortHash}\t${c.isoDate}\t${c.author}\t${subject}\t${c.filesChanged}\t${c.insertions}\t${c.deletions}\t${touched}`,
    );
  }
}

export const log = new Command("log")
  .description("Show git commit history for a path or symbol")
  .argument("<path-or-symbol>", "File/dir path or symbol name")
  .option("-l, --limit <n>", "Max commits (default 20)", "20")
  .option("--since <date>", "Filter by date (e.g. '2 weeks ago', '2025-01-01')")
  .option(
    "--from <ref>",
    "Show commits since git ref (translates to <ref>..HEAD)",
  )
  .option("--author <name>", "Filter by author")
  .option("--root <dir>", "Project root directory")
  .option(
    "--in <subpath>",
    "Restrict symbol resolution to a sub-path (repeatable; symbol mode only)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option(
    "--exclude <subpath>",
    "Exclude a sub-path from symbol resolution (repeatable; symbol mode only)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option(
    "--no-follow",
    "Disable rename tracking (default: enabled for single files in path mode)",
  )
  .option("--agent", "Compact TSV output for AI agents", false)
  .action(async (arg: string, opts) => {
    const limit = Math.min(
      Math.max(Number.parseInt(opts.limit || "20", 10), 1),
      200,
    );
    const root = resolveRootOrExit(opts.root);
    if (root === null) return;
    const projectRoot = findProjectRoot(root) ?? root;

    let vectorDb: VectorDB | null = null;
    try {
      // 1. Try arg as path (relative to projectRoot, then cwd).
      const candidates = [
        path.resolve(projectRoot, arg),
        path.resolve(process.cwd(), arg),
      ];
      let resolvedPath: string | null = null;
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          resolvedPath = c;
          break;
        }
      }

      if (resolvedPath) {
        const isDir = fs.statSync(resolvedPath).isDirectory();
        const commits = getCommitHistory({
          paths: [resolvedPath],
          limit,
          since: opts.since,
          from: opts.from,
          author: opts.author,
          follow: !isDir && opts.follow !== false,
          cwd: projectRoot,
        });
        if (commits.length === 0) {
          console.log(
            opts.agent
              ? ""
              : `No commits found for ${relativize(resolvedPath, projectRoot)}.`,
          );
          return;
        }
        if (opts.agent) printAgent(commits, projectRoot, null);
        else printHuman(commits, projectRoot, null);
        return;
      }

      // 2. Try arg as symbol via index lookup.
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);
      const symbolPaths = await resolveSymbolPaths(
        vectorDb,
        arg,
        projectRoot,
        opts.in,
        opts.exclude,
      );

      if (symbolPaths.length === 0) {
        console.error(`gmax log: no file or symbol matched '${arg}'`);
        if (!opts.agent) {
          console.error("");
          console.error(
            "Try `gmax search <term>` to find a symbol, or pass a file path.",
          );
        }
        process.exitCode = 1;
        return;
      }

      const commits = getCommitHistory({
        paths: symbolPaths,
        limit,
        since: opts.since,
        from: opts.from,
        author: opts.author,
        follow: false,
        cwd: projectRoot,
      });

      if (commits.length === 0) {
        console.log(
          opts.agent
            ? ""
            : `No commits found touching defining files for symbol '${arg}'.`,
        );
        return;
      }

      if (opts.agent) printAgent(commits, projectRoot, symbolPaths);
      else {
        if (symbolPaths.length > 1) {
          console.log(
            style.dim(
              `// '${arg}' defined in ${symbolPaths.length} files; commits merged by hash.`,
            ),
          );
          console.log();
        }
        printHuman(commits, projectRoot, symbolPaths);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Log failed:", msg);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch {}
      }
      await gracefulExit();
    }
  });
