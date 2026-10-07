import { detectIntent } from "../search/intent";
import { validateMaxPerFile } from "../search/per-file";
import { buildWhereClause } from "../search/searcher";
import type { ChunkType } from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { toArr } from "../utils/arrow";
import { withQueryTimeout } from "../utils/query-timeout";
import { assertReadableProject } from "./rows-handler";
import type { DaemonSearchPayload, DaemonSearchResult } from "./search-handler";

export const PAUSED_QUERY_TIMEOUT_MS = 2_000;
export const PAUSED_RESULT_LIMIT = 20;
export const PAUSED_CACHE_OPTIONS = {
  readOnly: true,
  indexCacheMb: 32,
  metadataCacheMb: 16,
} as const;

export class DaemonPausedError extends Error {
  readonly code = "DAEMON_PAUSED";
  constructor(reason: string) {
    super(
      `gmax is serving bounded reads; indexing and heavy work are paused: ${reason}`,
    );
    this.name = "DaemonPausedError";
  }
}

export function isPausedRead(name: string): boolean {
  return [
    "keyword-search",
    "rows.locate",
    "rows.skeleton",
    "graph.resolve",
    "unwatch",
    "llm-stop",
  ].includes(name);
}

/** Refuse oversized requests rather than silently truncating exact lookups. */
export function validatePausedRead(
  name: string,
  payload: Record<string, unknown>,
): void {
  if (!isPausedRead(name))
    throw new DaemonPausedError(`${name} needs the full service`);
  if (
    name === "graph.resolve" &&
    (typeof payload.target !== "string" ||
      payload.target.length > 4096 ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(payload.target))
  )
    throw new DaemonPausedError(
      "file-wide symbol enumeration is paused; use an exact symbol or bounded file lookup",
    );
  if (name === "rows.skeleton" && typeof payload.path !== "string")
    throw new DaemonPausedError(
      "paused skeleton lookup requires an exact file path",
    );
  if (name !== "rows.locate") return;
  const matches = Array.isArray(payload.matches) ? payload.matches : [];
  const limit =
    payload.limit === undefined ? PAUSED_RESULT_LIMIT : Number(payload.limit);
  if (
    matches.length > 4 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > PAUSED_RESULT_LIMIT ||
    payload.scoped === false ||
    matches.some(
      (m) =>
        !m ||
        !["definedSymbol", "path"].includes(
          String((m as { kind?: unknown }).kind),
        ),
    )
  ) {
    throw new DaemonPausedError(
      "use at most four scoped symbol/file lookups with a limit of 20",
    );
  }
}

/** Existing FTS only: no embedding, vector columns, rebuild or scan fallback. */
export async function searchPausedIndex(
  db: VectorDB,
  payload: DaemonSearchPayload,
  reason: string,
  signal: AbortSignal,
): Promise<DaemonSearchResult> {
  signal.throwIfAborted();
  const root = assertReadableProject(payload.projectRoot);
  for (const candidate of payload.filters?.projectRoots ?? [root])
    assertReadableProject(candidate);
  if (payload.query.length > 4096)
    throw new DaemonPausedError("query exceeds 4096 characters");
  const requestedLimit = payload.limit ?? 10;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1)
    throw new Error("invalid limit");
  const limit = Math.min(requestedLimit, PAUSED_RESULT_LIMIT);
  const maxPerFile = validateMaxPerFile(payload.maxPerFile);
  await db.adoptFTSIndex();
  signal.throwIfAborted();
  const table = await db.ensureTable();
  const prefix = payload.pathPrefix ?? `${root.replace(/\/$/, "")}/`;
  const where = buildWhereClause(
    payload.filters?.projectRoots ? undefined : prefix,
    payload.filters,
    detectIntent(payload.query),
  );
  let query = table
    .search(payload.query)
    .fastSearch()
    .select([
      "path",
      "hash",
      "content",
      "start_line",
      "end_line",
      "chunk_index",
      "role",
      "defined_symbols",
      "parent_symbol",
      "_score",
    ])
    .limit(PAUSED_RESULT_LIMIT);
  if (where) query = query.where(where);
  const rows = await withQueryTimeout(
    query.toArray({ timeoutMs: PAUSED_QUERY_TIMEOUT_MS }),
    "paused keyword search",
    PAUSED_QUERY_TIMEOUT_MS,
  );
  signal.throwIfAborted();
  const data: ChunkType[] = [];
  const counts = new Map<string, number>();
  const best = Math.max(1, ...rows.map((r) => Number(r._score) || 0));
  for (const row of rows) {
    const path = String(row.path ?? "");
    const count = counts.get(path) ?? 0;
    if (maxPerFile !== undefined && count >= maxPerFile) continue;
    counts.set(path, count + 1);
    data.push({
      type: "text",
      text: String(row.content ?? "").slice(0, 8192),
      score: (Number(row._score) || 0) / best,
      metadata: { path, hash: String(row.hash ?? "") },
      generated_metadata: {
        start_line: Number(row.start_line ?? 0),
        end_line: Number(row.end_line ?? 0),
      },
      chunk_index: Number(row.chunk_index ?? 0),
      role: String(row.role ?? ""),
      parent_symbol: String(row.parent_symbol ?? ""),
      defined_symbols: toArr(row.defined_symbols).filter(
        (s): s is string => typeof s === "string",
      ),
    });
    if (data.length >= limit) break;
  }
  return {
    ok: true,
    data,
    warnings: [
      `Keyword search only; embeddings and indexing are paused: ${reason}. Results use the retained FTS index and keyword scores; unindexed rows are excluded.`,
      ...(requestedLimit > limit
        ? [`Paused search is limited to ${limit} results.`]
        : []),
      ...(payload.includeGraph || payload.includeSkeletons
        ? [
            "Inline graph/skeleton enrichment is paused; use bounded file lookups.",
          ]
        : []),
    ],
  };
}
