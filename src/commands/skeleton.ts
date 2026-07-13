/**
 * gmax skeleton - Show code skeleton (signatures without implementation)
 *
 * Usage:
 *   gmax skeleton <file>           # Skeleton of a file
 *   gmax skeleton <symbol>         # Find symbol and skeleton its file
 *   gmax skeleton "query"          # Search and skeleton top results
 */

import * as fs from "node:fs";
import { Command } from "commander";
import { CONFIG } from "../config";
import { createIndexingSpinner } from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import { Searcher } from "../lib/search/searcher";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { getStoredSkeleton } from "../lib/skeleton/retriever";
import { Skeletonizer } from "../lib/skeleton/skeletonizer";
import { VectorDB } from "../lib/store/vector-db";
import { gracefulExit } from "../lib/utils/exit";
import { readContainedTextFileSync } from "../lib/utils/file-utils";
import { pathStartsWith } from "../lib/utils/filter-builder";
import { resolveContainedPath } from "../lib/utils/path-containment";
import { stampProjectFullSync } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

interface SkeletonOptions {
  limit: string;
  json: boolean;
  noSummary: boolean;
  sync: boolean;
  agent: boolean;
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
  projectRoot: string,
): Promise<string | null> {
  try {
    const table = await db.ensureTable();

    // Search for files that define this symbol
    const results = await table
      .search(symbol)
      .where(pathStartsWith(`${projectRoot}/`))
      .limit(10)
      .toArray();

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
  .option("--agent", "Compact output for AI agents", false)
  .addHelpText(
    "after",
    `
Examples:
  gmax skeleton src/lib/auth.ts  Show file structure
  gmax skeleton AuthService      Find symbol, show its file
  gmax skeleton "auth logic"     Search, skeletonize top matches
`,
  )
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
        const result = await initialSync({ projectRoot, onProgress });
        if (result.degraded) {
          spinner.warn(
            `Sync incomplete: ${result.scanErrors} scan error(s), ${result.failedFiles} file failure(s)`,
          );
        } else {
          const prefix = projectRoot.endsWith("/")
            ? projectRoot
            : `${projectRoot}/`;
          const chunkCount = await vectorDb.countRowsForPath(prefix);
          stampProjectFullSync({
            root: projectRoot,
            generation: result.generation,
            embedMode: result.embedMode,
            chunkCount,
            chunkerVersion: CONFIG.CHUNKER_VERSION,
            expectedFingerprint:
              result.registryExpectation.embeddingFingerprint,
            expectedRebuildId: result.registryExpectation.rebuildId,
          });
          spinner.succeed("Sync complete");
        }
      }

      // Initialize skeletonizer
      const skeletonizer = new Skeletonizer();
      await skeletonizer.init();

      const skeletonOpts = {
        includeSummary: !options.noSummary,
      };

      // Determine mode based on target
      const resolvedTarget = resolveContainedPath(projectRoot, target, {
        verifyExistingTarget: true,
      });

      // Directory mode is unsupported. Auto-picking files from a directory
      // was confusingly magical (and on '.' it fell through to the resolver
      // path and skeletonized .gitignore). Refuse and point at the file form.
      if (
        fs.existsSync(resolvedTarget) &&
        fs.statSync(resolvedTarget).isDirectory()
      ) {
        console.error(
          [
            "skeleton expects a file or symbol, not a directory.",
            "Try:",
            "  gmax skeleton src/foo.ts        # one file's structure",
            '  gmax search "<topic>" --agent   # find relevant files first',
          ].join("\n"),
        );
        process.exitCode = 1;
        return;
      }

      // Batch mode (comma-separated)
      if (target.includes(",")) {
        const targets = target
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        for (const t of targets) {
          const filePath = resolveContainedPath(projectRoot, t, {
            verifyExistingTarget: true,
          });
          if (!fs.existsSync(filePath)) {
            console.error(`Not found: ${t}`);
            continue;
          }
          const content = readContainedTextFileSync(projectRoot, filePath);
          const result = await skeletonizer.skeletonizeFile(
            filePath,
            content,
            skeletonOpts,
          );
          outputResult(result, options);
        }
        return;
      }

      if (isFilePath(target)) {
        // === FILE MODE ===
        const filePath = resolveContainedPath(projectRoot, target, {
          verifyExistingTarget: true,
        });

        if (!fs.existsSync(filePath)) {
          console.error(`File not found: ${filePath}`);
          process.exitCode = 1;
          return;
        }

        if (vectorDb) {
          // Use absolute path for DB lookup (centralized index stores absolute paths)
          const cached = await getStoredSkeleton(vectorDb, filePath);
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

        const content = readContainedTextFileSync(projectRoot, filePath);
        const result = await skeletonizer.skeletonizeFile(
          filePath,
          content,
          skeletonOpts,
        );

        outputResult(result, options);
      } else if (isSymbolLike(target) && !target.includes(" ")) {
        // === SYMBOL MODE ===
        const filePath = await findFileBySymbol(target, vectorDb, projectRoot);

        if (!filePath) {
          console.error(`Symbol not found in index: ${target}`);
          console.error(
            "Try running 'gmax index' first or use a search query.",
          );
          process.exitCode = 1;
          return;
        }

        // filePath from DB is absolute (centralized index)
        const absolutePath = resolveContainedPath(projectRoot, filePath, {
          verifyExistingTarget: true,
        });
        if (!fs.existsSync(absolutePath)) {
          console.error(`File not found: ${absolutePath}`);
          process.exitCode = 1;
          return;
        }

        const cached = await getStoredSkeleton(vectorDb!, absolutePath);
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

        const content = readContainedTextFileSync(projectRoot, absolutePath);
        const result = await skeletonizer.skeletonizeFile(
          absolutePath,
          content,
          skeletonOpts,
        );

        outputResult(result, options);
      } else {
        // === QUERY MODE ===
        const searcher = new Searcher(vectorDb);
        const limit = Math.min(Number.parseInt(options.limit, 10) || 3, 10);

        const searchResults = await searcher.search(
          target,
          limit,
          {},
          {},
          `${projectRoot}/`,
        );

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
          // Paths from search results are absolute (centralized index)
          let absolutePath: string;
          try {
            absolutePath = resolveContainedPath(projectRoot, filePath, {
              verifyExistingTarget: true,
            });
          } catch {
            results.push({
              file: filePath,
              skeleton: `// File outside selected project: ${filePath}`,
              tokens: 0,
              error: "File outside selected project",
            });
            continue;
          }

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
          const cached = await getStoredSkeleton(vectorDb!, absolutePath);
          if (cached) {
            results.push({
              file: filePath,
              skeleton: cached,
              tokens: Math.ceil(cached.length / 4),
            });
            continue;
          }

          const content = readContainedTextFileSync(projectRoot, absolutePath);
          const result = await skeletonizer.skeletonizeFile(
            absolutePath,
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
