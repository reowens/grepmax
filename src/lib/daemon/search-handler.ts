import type { IndexState } from "../output/index-state-footer";
import { Searcher } from "../search/searcher";
import { getStoredSkeleton } from "../skeleton/retriever";
import type { ChunkType, SearchFilter } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { getProject } from "../utils/project-registry";

export interface DaemonSearchPayload {
  projectRoot: string;
  query: string;
  limit: number;
  filters?: SearchFilter;
  pathPrefix?: string;
  rerank?: boolean;
  explain?: boolean;
  seeds?: { files?: string[]; symbols?: string[] };
  includeSkeletons?: boolean;
  skeletonLimit?: number;
  includeGraph?: boolean;
}

// A type alias (not an interface) so it keeps the implicit index signature that
// makes it assignable to the daemon's `DaemonResponse` ([key: string]: unknown).
export type DaemonSearchResult = {
  ok: boolean;
  data?: ChunkType[];
  warnings?: string[];
  skeletons?: Record<string, string>;
  graph?: unknown;
  indexState?: IndexState;
  error?: string;
  hint?: string;
};

/**
 * State the daemon search handler reads. Kept as a narrow interface so the
 * handler stays decoupled from the Daemon class — the daemon supplies its warm
 * VectorDB, its watcher/index bookkeeping, a per-root Searcher cache, and small
 * callbacks for index-state lookup and activity touch.
 */
export interface DaemonSearchDeps {
  vectorDb: VectorDB | null;
  processors: ReadonlyMap<string, unknown>;
  indexProgress: ReadonlyMap<string, unknown>;
  searchers: Map<string, Searcher>;
  getIndexState: (root: string) => IndexState;
  touchActivity: () => void;
}

/**
 * Daemon-side search: runs the hybrid+rerank against the already-warm VectorDB
 * and optionally attaches inline skeletons / a 1-hop graph / a partial-index
 * footer. Extracted from Daemon.search() (Phase 12) — behavior-preserving.
 */
export async function handleDaemonSearch(
  deps: DaemonSearchDeps,
  payload: DaemonSearchPayload,
  signal: AbortSignal,
): Promise<DaemonSearchResult> {
  const { vectorDb } = deps;
  if (!vectorDb) {
    return { ok: false, error: "daemon not ready" };
  }
  const root = payload.projectRoot;
  if (!deps.processors.has(root)) {
    // A full index (--reset) or the initial index removes/defers the
    // processor while (re)building. The partial index is still queryable, so
    // answer the search and flag it partial (below) rather than erroring —
    // only truly-unwatched, not-indexing projects get "not watched".
    const indexingNow =
      deps.indexProgress.has(root) || getProject(root)?.status === "pending";
    if (!indexingNow) {
      return {
        ok: false,
        error: "project not watched",
        hint: `run: gmax add ${root}`,
      };
    }
  }

  let searcher = deps.searchers.get(root);
  if (!searcher) {
    searcher = new Searcher(vectorDb);
    deps.searchers.set(root, searcher);
  }

  deps.touchActivity();

  let result;
  try {
    result = await searcher.search(
      payload.query,
      payload.limit,
      {
        rerank: payload.rerank === true,
        explain: payload.explain === true,
        seeds: payload.seeds,
      },
      payload.filters,
      payload.pathPrefix,
      undefined,
      signal,
    );
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      return { ok: false, error: "aborted" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "search_failed", hint: msg };
  }

  const response: {
    ok: boolean;
    data: ChunkType[];
    warnings?: string[];
    skeletons?: Record<string, string>;
    graph?: unknown;
    indexState?: IndexState;
  } = { ok: true, data: result.data };
  if (result.warnings?.length) response.warnings = result.warnings;

  // Annotate partial results when the index is still catching up, so an
  // agent can caveat or retry. Only attached when actually indexing (the
  // formatter suppresses the settled case anyway).
  const idx = deps.getIndexState(root);
  if (idx.indexing) response.indexState = idx;

  // --skeleton support: fetch per-file skeletons inline so the CLI doesn't
  // have to open its own VectorDB. getStoredSkeleton is a single LIMIT-1
  // lookup; cheap enough to call for the top N distinct paths.
  if (payload.includeSkeletons && result.data.length > 0) {
    const limit =
      payload.skeletonLimit && payload.skeletonLimit > 0
        ? payload.skeletonLimit
        : 5;
    const seen = new Set<string>();
    const skeletons: Record<string, string> = {};
    for (const chunk of result.data) {
      const p =
        (chunk as unknown as { path?: string }).path ??
        (chunk.metadata?.path as string | undefined);
      if (!p || seen.has(p)) continue;
      seen.add(p);
      if (seen.size > limit) break;
      try {
        const sk = await getStoredSkeleton(vectorDb, p);
        if (sk) skeletons[p] = sk;
      } catch {
        // best-effort — drop the entry, keep the search result
      }
    }
    if (Object.keys(skeletons).length > 0) response.skeletons = skeletons;
  }

  // --symbol support: build a 1-hop graph using the warm vectorDb. ~5
  // LanceDB queries; doesn't touch the worker pool.
  if (payload.includeGraph) {
    try {
      const { GraphBuilder } = await import("../graph/graph-builder");
      const builder = new GraphBuilder(vectorDb, root);
      response.graph = await builder.buildGraphMultiHop(payload.query, 1);
    } catch {
      // best-effort — drop graph, keep results
    }
  }

  // 2 MB cap on the JSON line. Lance can return huge chunks for unusual
  // queries (very long markdown blobs). Above this we fall back to the
  // in-process path which writes to stdout instead of a socket.
  const serialized = JSON.stringify(response);
  if (serialized.length > 2 * 1024 * 1024) {
    return {
      ok: false,
      error: "oversize",
      hint: `${serialized.length} bytes — falling back to in-process search`,
    };
  }
  return response;
}
