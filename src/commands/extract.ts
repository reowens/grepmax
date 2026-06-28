import * as fs from "node:fs";
import { Command } from "commander";
import { VectorDB } from "../lib/store/vector-db";
import { symbolNotFoundLines } from "../lib/utils/agent-errors";
import { gracefulExit } from "../lib/utils/exit";
import { escapeSqlString } from "../lib/utils/filter-builder";
import { extractImportsFromContent } from "../lib/utils/import-extractor";
import { groupByLanguage } from "../lib/utils/language";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const style = {
  bold: (s: string) => (useColors ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (useColors ? `\x1b[2m${s}\x1b[22m` : s),
  green: (s: string) => (useColors ? `\x1b[32m${s}\x1b[39m` : s),
  cyan: (s: string) => (useColors ? `\x1b[36m${s}\x1b[39m` : s),
};

const ROLE_PRIORITY: Record<string, number> = {
  ORCHESTRATION: 3,
  DEFINITION: 2,
  IMPLEMENTATION: 1,
};

interface ChunkMatch {
  path: string;
  startLine: number;
  endLine: number;
  role: string;
  exported: boolean;
  definedSymbols: string[];
}

async function findSymbolChunks(
  db: VectorDB,
  whereClause: string,
): Promise<ChunkMatch[]> {
  const table = await db.ensureTable();
  const rows = await table
    .query()
    .select([
      "path",
      "start_line",
      "end_line",
      "role",
      "is_exported",
      "defined_symbols",
    ])
    .where(whereClause)
    .limit(10)
    .toArray();

  return rows.map((row: any) => ({
    path: String(row.path || ""),
    startLine: Number(row.start_line || 0),
    endLine: Number(row.end_line || 0),
    role: String(row.role || "IMPLEMENTATION"),
    exported: Boolean(row.is_exported),
    definedSymbols: Array.isArray(row.defined_symbols)
      ? row.defined_symbols
      : [],
  }));
}

function pickBestMatch(chunks: ChunkMatch[], symbol: string): ChunkMatch {
  // Prefer chunks where the symbol is first in defined_symbols, then by role priority
  return chunks.sort((a, b) => {
    const aFirst = a.definedSymbols[0] === symbol ? 1 : 0;
    const bFirst = b.definedSymbols[0] === symbol ? 1 : 0;
    if (bFirst !== aFirst) return bFirst - aFirst;
    return (ROLE_PRIORITY[b.role] || 0) - (ROLE_PRIORITY[a.role] || 0);
  })[0];
}

export const extract = new Command("extract")
  .description("Extract full function/class body by symbol name")
  .argument("<symbol>", "The symbol to extract")
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
  .option("--agent", "Compact output for AI agents", false)
  .option("--imports", "Prepend file imports", false)
  .option("--no-tests", "Suppress the tests footer")
  .action(async (symbol, opts) => {
    let vectorDb: VectorDB | null = null;
    const root = resolveRootOrExit(opts.root);
    if (root === null) return;

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
      const where = buildScopeWhere(
        scope,
        `array_contains(defined_symbols, '${escapeSqlString(symbol)}')`,
      );
      const chunks = await findSymbolChunks(vectorDb, where);

      if (chunks.length === 0) {
        console.log(
          symbolNotFoundLines(symbol, {
            agent: opts.agent,
            dim: style.dim,
            bold: style.bold,
          }).join("\n"),
        );
        process.exitCode = 1;
        return;
      }

      // Cross-language disambiguation: when the symbol is defined in 2+
      // languages, refuse to silently pick one. Listing all matches with a
      // recovery hint avoids the dogfooded failure mode where peek picked
      // Swift but listed TS callers.
      const byLang = groupByLanguage(chunks);
      if (byLang.size >= 2) {
        const rel = (p: string) =>
          p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p;
        const lines = [`Symbol '${symbol}' is defined in multiple languages:`];
        for (const [lang, group] of byLang) {
          const c = group[0];
          lines.push(`  ${lang.padEnd(6)} ${rel(c.path)}:${c.startLine + 1}`);
        }
        lines.push(
          `Disambiguate with --root or pin to a path: gmax extract ${symbol} --root <project-root>`,
        );
        console.log(lines.join("\n"));
        process.exitCode = 1;
        return;
      }

      const best = pickBestMatch(chunks, symbol);
      const content = fs.readFileSync(best.path, "utf-8");
      const allLines = content.split("\n");
      const startLine = best.startLine; // 0-based
      const endLine = Math.min(best.endLine, allLines.length - 1);
      const body = allLines.slice(startLine, endLine + 1);
      const relPath = best.path.startsWith(projectRoot)
        ? best.path.slice(projectRoot.length + 1)
        : best.path;

      if (opts.agent) {
        // Compact: path:start-end header then raw code
        if (opts.imports) {
          const imports = extractImportsFromContent(content);
          if (imports) console.log(imports);
        }
        console.log(`${relPath}:${startLine + 1}-${endLine + 1}`);
        console.log(body.join("\n"));
        if (opts.tests !== false) {
          const { fetchTestsForFooter, renderTestsFooterAgent } = await import(
            "../lib/utils/tests-footer"
          );
          const tests = await fetchTestsForFooter(
            symbol,
            vectorDb,
            scope.pathPrefix,
            scope.excludePrefixes,
          );
          if (tests && tests.length > 0) {
            console.log("--- tests:");
            for (const line of renderTestsFooterAgent(tests, projectRoot)) {
              console.log(line);
            }
          }
        }
      } else {
        // Rich output with line numbers
        if (opts.imports) {
          const imports = extractImportsFromContent(content);
          if (imports) {
            console.log(style.dim(imports));
            console.log();
          }
        }

        const exportedStr = best.exported ? ", exported" : "";
        console.log(
          style.dim(
            `// ${relPath}:${startLine + 1}-${endLine + 1} [${best.role}${exportedStr}]`,
          ),
        );
        const lineNumWidth = String(endLine + 1).length;
        for (let i = 0; i < body.length; i++) {
          const lineNum = String(startLine + 1 + i).padStart(lineNumWidth);
          console.log(`${style.dim(`${lineNum}\u2502`)} ${body[i]}`);
        }
      }

      // Show other definitions if symbol exists in multiple files
      const others = chunks.filter((c) => c !== best).slice(0, 3);
      if (others.length > 0 && !opts.agent) {
        const otherLocs = others
          .map((c) => {
            const r = c.path.startsWith(projectRoot)
              ? c.path.slice(projectRoot.length + 1)
              : c.path;
            return `${r}:${c.startLine + 1}`;
          })
          .join(", ");
        console.log(`\n${style.dim(`Also defined in: ${otherLocs}`)}`);
      }

      if (!opts.agent && opts.tests !== false) {
        const { fetchTestsForFooter, renderTestsFooterHuman } = await import(
          "../lib/utils/tests-footer"
        );
        const tests = await fetchTestsForFooter(
          symbol,
          vectorDb,
          scope.pathPrefix,
          scope.excludePrefixes,
        );
        if (tests && tests.length > 0) {
          for (const line of renderTestsFooterHuman(tests, projectRoot)) {
            console.log(line);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Extract failed:", message);
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
