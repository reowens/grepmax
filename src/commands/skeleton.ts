/**
 * osgrep skeleton - Show code skeleton (signatures without implementation)
 *
 * Usage:
 *   osgrep skeleton <file>           # Skeleton of a file
 *   osgrep skeleton <symbol>         # Find symbol and skeleton its file
 *   osgrep skeleton "query"          # Search and skeleton top results
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { createIndexingSpinner } from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import { Searcher } from "../lib/search/searcher";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { getStoredSkeleton } from "../lib/skeleton/retriever";
import { Skeletonizer } from "../lib/skeleton/skeletonizer";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

interface SkeletonOptions {
  limit: string;
  json: boolean;
  noSummary: boolean;
  sync: boolean;
}

/**
 * Check if target looks like a file path.
 */
function isFilePath(target: string): boolean {
  // Has path separator or file extension
  return (
    target.includes("/") || target.includes("\\") || /\.\w{1,10}$/.test(target)
  );
}

/**
 * Check if target looks like a symbol name (PascalCase or camelCase identifier).
 */
function isSymbolLike(target: string): boolean {
  // PascalCase class name or camelCase function name
  // Must be a single word without spaces
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(target) && !target.includes(" ");
}

/**
 * Find a file by symbol name in the index.
 */
async function findFileBySymbol(
  symbol: string,
  db: VectorDB,
): Promise<string | null> {
  try {
    const table = await db.ensureTable();

    // Search for files that define this symbol
    const results = await table.search(symbol).limit(10).toArray();

    // Find a result where this symbol is defined
    for (const result of results) {
      const defined = result.defined_symbols as string[] | undefined;
      if (defined?.includes(symbol)) {
        return result.path as string;
      }
    }

    // Fallback: just return the first match's file
    if (results.length > 0) {
      return results[0].path as string;
    }

    return null;
  } catch {
    return null;
  }
}

export const skeleton = new Command("skeleton")
  .description("Show code skeleton (signatures without implementation)")
  .argument("<target>", "File path, symbol name, or search query")
  .option("-l, --limit <n>", "Max files for query mode", "3")
  .option("--json", "Output as JSON", false)
  .option("--no-summary", "Omit call/complexity summary in bodies", false)
  .option("-s, --sync", "Sync index before searching", false)
  .action(async (target: string, options: SkeletonOptions, _cmd) => {
    let vectorDb: VectorDB | null = null;

    try {
      // Initialize
      await ensureSetup();
      const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      // Sync if requested
      if (options.sync) {
        const { spinner, onProgress } = createIndexingSpinner(
          projectRoot,
          "Syncing...",
          { verbose: false },
        );
        await initialSync({ projectRoot, onProgress });
        spinner.succeed("Sync complete");
      }

      // Initialize skeletonizer
      const skeletonizer = new Skeletonizer();
      await skeletonizer.init();

      const skeletonOpts = {
        includeSummary: !options.noSummary,
      };

      // Determine mode based on target
      if (isFilePath(target)) {
        // === FILE MODE ===
        const filePath = path.resolve(target);

        if (!fs.existsSync(filePath)) {
          console.error(`File not found: ${filePath}`);
          process.exitCode = 1;
          return;
        }

        if (vectorDb) {
          const relativeToProject = path.relative(projectRoot, filePath);
          const cached = await getStoredSkeleton(vectorDb, relativeToProject);
          if (cached) {
            outputResult(
              {
                success: true,
                skeleton: cached,
                tokenEstimate: Math.ceil(cached.length / 4),
              },
              options,
            );
            return;
          }
        }

        const content = fs.readFileSync(filePath, "utf-8");
        const result = await skeletonizer.skeletonizeFile(
          filePath,
          content,
          skeletonOpts,
        );

        outputResult(result, options);
      } else if (isSymbolLike(target) && !target.includes(" ")) {
        // === SYMBOL MODE ===
        const filePath = await findFileBySymbol(target, vectorDb);

        if (!filePath) {
          console.error(`Symbol not found in index: ${target}`);
          console.error(
            "Try running 'osgrep index' first or use a search query.",
          );
          process.exitCode = 1;
          return;
        }

        const absolutePath = path.resolve(projectRoot, filePath);
        if (!fs.existsSync(absolutePath)) {
          console.error(`File not found: ${absolutePath}`);
          process.exitCode = 1;
          return;
        }

        const cached = await getStoredSkeleton(vectorDb!, filePath);
        if (cached) {
          outputResult(
            {
              success: true,
              skeleton: cached,
              tokenEstimate: Math.ceil(cached.length / 4),
            },
            options,
          );
          return;
        }

        const content = fs.readFileSync(absolutePath, "utf-8");
        const result = await skeletonizer.skeletonizeFile(
          filePath,
          content,
          skeletonOpts,
        );

        outputResult(result, options);
      } else {
        // === QUERY MODE ===
        const searcher = new Searcher(vectorDb);
        const limit = Math.min(Number.parseInt(options.limit, 10) || 3, 10);

        const searchResults = await searcher.search(target, limit);

        if (!searchResults.data || searchResults.data.length === 0) {
          console.error(`No results found for: ${target}`);
          process.exitCode = 1;
          return;
        }

        // Get unique file paths from results
        const seenPaths = new Set<string>();
        const filePaths: string[] = [];

        for (const result of searchResults.data) {
          const resultPath = (result.metadata as { path?: string })?.path;
          if (resultPath && !seenPaths.has(resultPath)) {
            seenPaths.add(resultPath);
            filePaths.push(resultPath);
            if (filePaths.length >= limit) break;
          }
        }

        // Skeletonize each file
        const results: Array<{
          file: string;
          skeleton: string;
          tokens: number;
          error?: string;
        }> = [];

        for (const filePath of filePaths) {
          const absolutePath = path.resolve(projectRoot, filePath);

          if (!fs.existsSync(absolutePath)) {
            results.push({
              file: filePath,
              skeleton: `// File not found: ${filePath}`,
              tokens: 0,
              error: "File not found",
            });
            continue;
          }

          // Try cache first
          const cached = await getStoredSkeleton(vectorDb!, filePath);
          if (cached) {
            results.push({
              file: filePath,
              skeleton: cached,
              tokens: Math.ceil(cached.length / 4),
            });
            continue;
          }

          const content = fs.readFileSync(absolutePath, "utf-8");
          const result = await skeletonizer.skeletonizeFile(
            filePath,
            content,
            skeletonOpts,
          );

          results.push({
            file: filePath,
            skeleton: result.skeleton,
            tokens: result.tokenEstimate,
            error: result.error,
          });
        }

        // Output results
        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          for (const result of results) {
            console.log(result.skeleton);
            console.log(""); // Blank line between files
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error:", message);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch {
          // Ignore close errors
        }
      }
      const code = typeof process.exitCode === "number" ? process.exitCode : 0;
      await gracefulExit(code);
    }
  });

/**
 * Output a skeleton result.
 */
function outputResult(
  result: {
    success: boolean;
    skeleton: string;
    tokenEstimate: number;
    error?: string;
  },
  options: SkeletonOptions,
): void {
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          success: result.success,
          skeleton: result.skeleton,
          tokens: result.tokenEstimate,
          error: result.error,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(result.skeleton);
  }
}
