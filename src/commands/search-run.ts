import * as path from "node:path";
import { ensureGrammars } from "../lib/index/grammar-loader";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/index/sync-helpers";
import { initialSync } from "../lib/index/syncer";
import type { IndexState } from "../lib/output/index-state-footer";
import { Searcher } from "../lib/search/searcher";
import type { SearchFilter, SearchResponse } from "../lib/store/types";
import { VectorDB } from "../lib/store/vector-db";
import { isLocked } from "../lib/utils/lock";

export interface SearchOptions {
  m: string;
  content: boolean;
  perFile: string;
  scores: boolean;
  minScore: string;
  compact: boolean;
  plain: boolean;
  sync: boolean;
  dryRun: boolean;
  skeleton: boolean;
  root: string;
  file: string;
  in?: string[];
  exclude?: string[];
  allProjects?: boolean;
  projects?: string;
  excludeProjects?: string;
  lang: string;
  role: string;
  symbol: boolean;
  imports: boolean;
  name: string;
  context: string;
  agent: boolean;
  explain: boolean;
  contextForLlm: boolean;
  budget: string;
  seedFile?: string[];
  seedSymbol?: string[];
}

export interface RunSearchParams {
  pattern: string;
  options: SearchOptions;
  projectRoot: string;
  effectiveRoot: string;
  paths: { lancedbDir: string; dataDir: string };
  projectStatus: string | undefined;
  searchFilters: Record<string, unknown>;
  pathFilter: string | undefined;
  seeds: { files?: string[]; symbols?: string[] } | undefined;
}

export type RunSearchResult =
  | { kind: "dry-run"; vectorDb: VectorDB | null }
  | {
      kind: "result";
      vectorDb: VectorDB | null;
      searchResult: SearchResponse;
      precomputedSkeletons?: Record<string, string>;
      precomputedGraph?: any;
      indexState?: IndexState;
    };

/**
 * Acquire search results, picking the path: daemon-mediated first (ships the
 * query over IPC to the already-warm daemon), in-process fallback otherwise
 * (opens VectorDB, ensures the index, runs Searcher). The presentation/render
 * stage stays in the command action.
 *
 * On success/dry-run the opened VectorDB (if any) is returned for the caller to
 * close after rendering; if indexing throws, it is closed here before rethrow.
 */
export async function runSearch(
  params: RunSearchParams,
): Promise<RunSearchResult> {
  const {
    pattern,
    options,
    projectRoot,
    effectiveRoot,
    paths,
    projectStatus,
    searchFilters,
    pathFilter,
    seeds,
  } = params;

  // Tracks a DB opened by the in-process path so it can be (a) returned to the
  // caller for closing after render, or (b) closed here if indexing throws.
  let openedDb: VectorDB | null = null;
  try {
    // Daemon-mediated search: ships query+args over IPC, daemon runs the
    // hybrid+rerank against its already-warm VectorDB and worker pool.
    // Drops cold-start cost (~17s wall, 6GB RAM in the CLI) to <1s. Falls
    // back to in-process on any failure.
    let searchResult: SearchResponse | null = null;
    let precomputedSkeletons: Record<string, string> | undefined;
    let precomputedGraph: any | undefined;
    let indexState: IndexState | undefined;
    if (!options.sync && !options.dryRun) {
      try {
        const { isDaemonRunning, sendDaemonCommand } = await import(
          "../lib/utils/daemon-client"
        );
        if (await isDaemonRunning()) {
          const resp = await sendDaemonCommand(
            {
              cmd: "search",
              projectRoot: effectiveRoot,
              query: pattern,
              limit: parseInt(options.m, 10),
              filters:
                Object.keys(searchFilters).length > 0
                  ? searchFilters
                  : undefined,
              pathPrefix: pathFilter,
              rerank: process.env.GMAX_RERANK === "1",
              explain: options.explain,
              seeds,
              includeSkeletons: options.skeleton,
              includeGraph: options.symbol,
            },
            { timeoutMs: 60_000 },
          );
          if (resp.ok) {
            searchResult = {
              data: resp.data as SearchResponse["data"],
              warnings: resp.warnings as string[] | undefined,
            };
            precomputedSkeletons = resp.skeletons as
              | Record<string, string>
              | undefined;
            precomputedGraph = resp.graph;
            indexState = resp.indexState as IndexState | undefined;
          } else if (process.env.GMAX_DEBUG === "1") {
            console.error(
              `[search] daemon path unavailable: ${resp.error ?? "unknown"}`,
            );
          }
        }
      } catch (err) {
        if (process.env.GMAX_DEBUG === "1") {
          console.error("[search] daemon attempt threw:", err);
        }
      }
    }

    // In-process fallback: open VectorDB, ensure index, run Searcher.
    // Only entered when the daemon path didn't produce results.
    if (!searchResult) {
      const vectorDb = new VectorDB(paths.lancedbDir);
      openedDb = vectorDb;

      // Check for active indexing lock and warn if present
      const locked = isLocked(paths.dataDir);
      if (!options.agent && locked) {
        console.warn(
          "⚠️  Warning: Indexing in progress... search results may be incomplete.",
        );
      }
      // No daemon here, so no precise pending count — surface the coarse
      // signal (active lock or initial index not yet complete) so agent mode
      // still gets a partial-index footer.
      if (!indexState && (locked || projectStatus === "pending")) {
        indexState = { indexing: true, pendingFiles: 0 };
      }

      // Decide first-run auto-index by whether the project being searched has
      // rows — NOT whether the shared store has any rows at all. The store is
      // centralized, so a global hasAnyRows() lets a sibling project's rows
      // suppress this project's first-run index. Cross-project mode keeps the
      // global check: it spans already-indexed projects and must not first-run
      // a single directory just because the cwd happens to be unindexed.
      const crossProject =
        !!options.allProjects ||
        !!options.projects ||
        !!options.excludeProjects;
      const hasRows = crossProject
        ? await vectorDb.hasAnyRows()
        : await vectorDb.hasRowsForPath(effectiveRoot);
      const needsSync = options.sync || !hasRows;

      if (needsSync) {
        const isTTY = process.stdout.isTTY;
        let abortController: AbortController | undefined;
        let signal: AbortSignal | undefined;

        if (!isTTY) {
          abortController = new AbortController();
          signal = abortController.signal;
          setTimeout(() => {
            abortController?.abort();
          }, 60000); // 60 seconds timeout for non-TTY auto-indexing
        }

        const { spinner, onProgress } = createIndexingSpinner(
          projectRoot,
          options.sync ? "Indexing..." : "Indexing repository (first run)...",
        );

        try {
          await ensureGrammars(console.log, { silent: true });
          const result = await initialSync({
            projectRoot,
            dryRun: options.dryRun,
            onProgress,
            signal,
          });

          if (signal?.aborted) {
            spinner.warn(
              `Indexing timed out (${result.processed}/${result.total}). Results may be partial.`,
            );
          }

          if (options.dryRun) {
            spinner.succeed(
              `Dry run complete (${result.processed}/${result.total}) • would have indexed ${result.indexed}`,
            );
            console.log(
              formatDryRunSummary(result, {
                actionDescription: "would have indexed",
                includeTotal: true,
              }),
            );
            return { kind: "dry-run", vectorDb: openedDb };
          }

          await vectorDb.createFTSIndex();

          // Update registry after sync
          const { readGlobalConfig } = await import(
            "../lib/index/index-config"
          );
          const { registerProject } = await import(
            "../lib/utils/project-registry"
          );
          const gc = readGlobalConfig();
          registerProject({
            root: projectRoot,
            name: path.basename(projectRoot),
            vectorDim: gc.vectorDim,
            modelTier: gc.modelTier,
            embedMode: gc.embedMode,
            lastIndexed: new Date().toISOString(),
            chunkCount: result.indexed,
            status: "indexed",
          });

          const failedSuffix =
            result.failedFiles > 0 ? ` • ${result.failedFiles} failed` : "";
          spinner.succeed(
            `${options.sync ? "Indexing" : "Initial indexing"} complete (${result.processed}/${result.total}) • indexed ${result.indexed}${failedSuffix}`,
          );
        } catch (e) {
          spinner.fail("Indexing failed");
          throw e;
        }
      }

      // Ensure a watcher is running for live reindexing
      if (!process.env.VITEST && !process.env.NODE_ENV?.includes("test")) {
        const { launchWatcher } = await import("../lib/utils/watcher-launcher");
        const launched = await launchWatcher(projectRoot);
        if (!launched.ok && launched.reason === "spawn-failed") {
          console.warn(`[search] ${launched.message}`);
        }
      }

      const searcher = new Searcher(vectorDb);

      searchResult = await searcher.search(
        pattern,
        parseInt(options.m, 10),
        {
          rerank: process.env.GMAX_RERANK === "1",
          explain: options.explain,
          seeds,
        },
        Object.keys(searchFilters).length > 0
          ? (searchFilters as SearchFilter)
          : undefined,
        pathFilter,
      );
    } // end if (!searchResult) — in-process fallback

    return {
      kind: "result",
      vectorDb: openedDb,
      searchResult,
      precomputedSkeletons,
      precomputedGraph,
      indexState,
    };
  } catch (e) {
    // Mirror the original action's finally: close a DB opened mid-flight when
    // indexing throws, before the error propagates to the caller.
    if (openedDb) {
      try {
        await openedDb.close();
      } catch {}
    }
    throw e;
  }
}
