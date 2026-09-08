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
import {
  runSkeleton,
  type SkeletonLookup,
  withLocalStore,
} from "../lib/daemon/rows-handler";
import { createIndexingSpinner } from "../lib/index/sync-helpers";
import { Searcher } from "../lib/search/searcher";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { Skeletonizer } from "../lib/skeleton/skeletonizer";
import type { ChunkType } from "../lib/store/types";
import {
  sendDaemonCommand,
  sendStreamingCommand,
} from "../lib/utils/daemon-client";
import { gracefulExit } from "../lib/utils/exit";
import { readContainedTextFileSync } from "../lib/utils/file-utils";
import {
  resolveContainedExistingPath,
  resolveContainedPath,
} from "../lib/utils/path-containment";
import { stampProjectFullSync } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  reportStoreAccessRefusal,
  withStoreRead,
} from "../lib/utils/store-access";

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
 * `--sync`. With a daemon up this is the existing `ensure-project` streaming
 * verb — the daemon already owns first-run indexing and is the only process
 * that should be writing to the store. `initialSync` runs here only when no
 * daemon is listening.
 */
async function syncIndex(
  projectRoot: string,
  lancedbDir: string,
): Promise<void> {
  const { spinner, onProgress } = createIndexingSpinner(
    projectRoot,
    "Syncing...",
    { verbose: false },
  );

  await withStoreRead<void>("skeleton sync", {
    daemon: async () => {
      try {
        const done = await sendStreamingCommand(
          { cmd: "ensure-project", root: projectRoot },
          (msg) =>
            onProgress({
              processed: Number(msg.processed ?? 0),
              total: Number(msg.total ?? 0),
              indexed: Number(msg.indexed ?? 0),
              filePath: typeof msg.filePath === "string" ? msg.filePath : "",
            }),
        );
        return { ...done, ok: done.ok !== false };
      } catch (err) {
        // sendStreamingCommand rejects with the socket errno as the message,
        // which is exactly what the access policy classifies on.
        return {
          ok: false,
          error:
            (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message,
        };
      }
    },
    render: () => {
      spinner.succeed("Sync complete");
    },
    inProcess: async () => {
      const { initialSync } = await import("../lib/index/syncer");
      const result = await initialSync({ projectRoot, onProgress });
      if (result.degraded) {
        spinner.warn(
          `Sync incomplete: ${result.scanErrors} scan error(s), ${result.failedFiles} file failure(s)`,
        );
        return;
      }
      const prefix = projectRoot.endsWith("/")
        ? projectRoot
        : `${projectRoot}/`;
      const chunkCount = await withLocalStore(lancedbDir, (deps) =>
        deps.vectorDb!.countRowsForPath(prefix),
      );
      stampProjectFullSync({
        root: projectRoot,
        generation: result.generation,
        embedMode: result.embedMode,
        chunkCount,
        chunkerVersion: CONFIG.CHUNKER_VERSION,
        expectedFingerprint: result.registryExpectation.embeddingFingerprint,
        expectedRebuildId: result.registryExpectation.rebuildId,
      });
      spinner.succeed("Sync complete");
    },
  });
}

/**
 * The stored skeleton for a file, and/or the file that defines a symbol. One
 * verb covers both because symbol mode always follows the lookup with the
 * skeleton fetch.
 */
async function lookupSkeleton(
  projectRoot: string,
  lancedbDir: string,
  req: { path?: string; symbol?: string },
): Promise<SkeletonLookup> {
  return withStoreRead<SkeletonLookup>("skeleton", {
    daemon: () =>
      sendDaemonCommand(
        {
          cmd: "rows.skeleton",
          projectRoot,
          path: req.path,
          symbol: req.symbol,
        },
        { timeoutMs: 30_000 },
      ),
    render: (resp) => ({
      path: (resp.path ?? null) as string | null,
      skeleton: (resp.skeleton ?? null) as string | null,
    }),
    inProcess: () =>
      withLocalStore(lancedbDir, (deps) =>
        runSkeleton(deps, { projectRoot, ...req }),
      ),
    fallbackOnUnknownVerb: true,
  });
}

/**
 * Query mode's search. Routed through the daemon's `search` verb so the
 * Searcher — and with it the PageRank cache under ~/.gmax/pagerank/ — stays in
 * one process.
 */
async function searchFiles(
  projectRoot: string,
  lancedbDir: string,
  query: string,
  limit: number,
): Promise<ChunkType[]> {
  return withStoreRead<ChunkType[]>("skeleton search", {
    daemon: () =>
      sendDaemonCommand(
        {
          cmd: "search",
          projectRoot,
          query,
          limit,
          pathPrefix: projectRoot,
        },
        { timeoutMs: 60_000 },
      ),
    render: (resp) => (resp.data ?? []) as ChunkType[],
    inProcess: () =>
      withLocalStore(lancedbDir, async (deps) => {
        const searcher = new Searcher(deps.vectorDb!);
        const results = await searcher.search(
          query,
          limit,
          {},
          {},
          `${projectRoot}/`,
        );
        return results.data ?? [];
      }),
  });
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
    try {
      // Initialize
      await ensureSetup();
      const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
      const paths = ensureProjectPaths(projectRoot);
      const lancedbDir = paths.lancedbDir;

      // Sync if requested
      if (options.sync) {
        await syncIndex(projectRoot, lancedbDir);
      }

      // Initialize skeletonizer
      const skeletonizer = new Skeletonizer();
      await skeletonizer.init();

      const skeletonOpts = {
        includeSummary: !options.noSummary,
      };

      // Determine mode based on target. Prefer an existing cwd-relative
      // match so callers inside a subdirectory (or nested subrepo) can pass
      // paths relative to where they are.
      const resolvedTarget =
        resolveContainedExistingPath(projectRoot, target) ??
        resolveContainedPath(projectRoot, target, {
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
          const filePath =
            resolveContainedExistingPath(projectRoot, t) ??
            resolveContainedPath(projectRoot, t, {
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
        const filePath =
          resolveContainedExistingPath(projectRoot, target) ??
          resolveContainedPath(projectRoot, target, {
            verifyExistingTarget: true,
          });

        if (!fs.existsSync(filePath)) {
          console.error(`File not found: ${filePath}`);
          process.exitCode = 1;
          return;
        }

        // Use absolute path for DB lookup (centralized index stores absolute paths)
        const cached = (
          await lookupSkeleton(projectRoot, lancedbDir, { path: filePath })
        ).skeleton;
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

        const content = readContainedTextFileSync(projectRoot, filePath);
        const result = await skeletonizer.skeletonizeFile(
          filePath,
          content,
          skeletonOpts,
        );

        outputResult(result, options);
      } else if (isSymbolLike(target) && !target.includes(" ")) {
        // === SYMBOL MODE ===
        const found = await lookupSkeleton(projectRoot, lancedbDir, {
          symbol: target,
        });

        if (!found.path) {
          console.error(`Symbol not found in index: ${target}`);
          console.error(
            "Try running 'gmax index' first or use a search query.",
          );
          process.exitCode = 1;
          return;
        }

        // filePath from DB is absolute (centralized index)
        const absolutePath = resolveContainedPath(projectRoot, found.path, {
          verifyExistingTarget: true,
        });
        if (!fs.existsSync(absolutePath)) {
          console.error(`File not found: ${absolutePath}`);
          process.exitCode = 1;
          return;
        }

        const cached = found.skeleton;
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
        const limit = Math.min(Number.parseInt(options.limit, 10) || 3, 10);
        const searchData = await searchFiles(
          projectRoot,
          lancedbDir,
          target,
          limit,
        );

        if (searchData.length === 0) {
          console.error(`No results found for: ${target}`);
          process.exitCode = 1;
          return;
        }

        // Get unique file paths from results
        const seenPaths = new Set<string>();
        const filePaths: string[] = [];

        for (const result of searchData) {
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
          const cached = (
            await lookupSkeleton(projectRoot, lancedbDir, {
              path: absolutePath,
            })
          ).skeleton;
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
      if (!reportStoreAccessRefusal(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Error:", message);
        process.exitCode = 1;
      }
    } finally {
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
