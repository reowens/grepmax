import * as path from "node:path";
import {
  canonicalPointer,
  DOCUMENT_CONTRACT_VERSION,
  DOCUMENT_LIMITS,
  type DocumentContext,
  documentCoveragePaths,
  documentFailure,
  documentGeneration,
  documentIndexedAt,
  documentIndexState,
  documentMtime,
  documentPaths,
  documentQueryState,
  selectDocumentContext,
} from "../mcp/document-contract";
import type { MetaEntry } from "../store/meta-cache";

export interface DocumentSearchDeps {
  home: string;
  state: () => string;
  generation: () => number | null;
  embeddingState: (wireRoot: string) => string;
  meta: (file: string) => MetaEntry | undefined;
  queryState: () => string;
  encode: (query: string, signal: AbortSignal) => Promise<{ dense: number[] }>;
  // Caller provides only its already-open table, never ensureTable/getDb.
  table: () => Promise<any>;
  indexState: (root: string) => unknown;
  lastIndexed?: (root: string) => unknown;
}
function sqlString(input: string): string {
  return `'${input.replace(/'/g, "''")}'`;
}
export function documentFilter(prefixes: string[]): string {
  return `(${prefixes
    .map((prefix) => {
      const dir = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
      return `(path = ${sqlString(prefix)} OR (path >= ${sqlString(dir)} AND path < ${sqlString(`${dir}\uffff`)}))`;
    })
    .join(" OR ")}) AND lower(path) LIKE '%.md'`;
}
export async function handleDocumentSearch(
  deps: DocumentSearchDeps,
  cmd: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown> & { ok: boolean }> {
  try {
    const deadline = performance.now() + DOCUMENT_LIMITS.deadlineMs;
    signal = AbortSignal.any([
      signal,
      AbortSignal.timeout(DOCUMENT_LIMITS.deadlineMs),
    ]);
    signal.throwIfAborted();
    if (cmd.contractVersion !== DOCUMENT_CONTRACT_VERSION)
      return documentFailure("unsupported_tool");
    if (deps.state() !== "ready") return documentFailure(deps.state());
    if (typeof cmd.checkout !== "string") return documentFailure("no_index");
    const context: DocumentContext = selectDocumentContext(
      deps.home,
      cmd.checkout,
    );
    if (cmd.projectRoot !== context.wireRoot || cmd.store !== context.store)
      return documentFailure("store_unavailable");
    const embeddingState = deps.embeddingState(context.wireRoot);
    if (embeddingState !== "ready") return documentFailure(embeddingState);
    const generation = deps.generation();
    if (!documentGeneration(generation))
      return documentFailure("index_unavailable");
    if (!documentGeneration(cmd.generation) || cmd.generation !== generation)
      return documentFailure("embedding_mismatch");
    const recheck = () => {
      signal.throwIfAborted();
      if (performance.now() >= deadline) throw new Error("timeout");
      if (deps.state() !== "ready") throw new Error(deps.state());
      if (
        deps.generation() !== generation ||
        deps.embeddingState(context.wireRoot) !== "ready"
      )
        throw new Error("embedding_mismatch");
    };
    const base = {
      ok: true,
      root: context.root,
      store: context.store,
      generation,
    };
    if (cmd.cmd === "documents.status") {
      const { paths, requested } = documentCoveragePaths(cmd.paths, context);
      const covered = paths.flatMap((file) => {
        const entry = deps.meta(file);
        return entry?.hasVectors === true
          ? [
              {
                path: file,
                ...(entry.hashVersion === 1 && /^[a-f0-9]{64}$/.test(entry.hash)
                  ? { hash: entry.hash, hashAlgorithm: "sha256-bytes" }
                  : {}),
                ...(documentMtime(entry.mtimeMs) !== null
                  ? { indexedMtimeMs: entry.mtimeMs }
                  : {}),
              },
            ]
          : [];
      });
      recheck();
      const state = documentQueryState(deps.queryState());
      return {
        ...base,
        embeddingReady: state === "ready",
        queryState: state,
        lastIndexed:
          documentIndexedAt(deps.lastIndexed?.(context.wireRoot)) ??
          context.lastIndexed,
        indexState: documentIndexState(deps.indexState(context.wireRoot)),
        covered,
        coverage: {
          requested,
          indexed: covered.length,
          partial: covered.length !== requested,
        },
      };
    }
    if (cmd.cmd !== "documents.search")
      return documentFailure("unsupported_tool");
    if (
      typeof cmd.query !== "string" ||
      !cmd.query.trim() ||
      cmd.query.length > DOCUMENT_LIMITS.query
    )
      return documentFailure("search_unavailable");
    const prefixes = documentPaths(cmd.prefixes, context, "prefixes");
    const state = deps.queryState();
    if (state !== "ready") return documentFailure(state);
    recheck();
    const encoded = await deps.encode(cmd.query, signal);
    recheck();
    if (!encoded.dense.length || !encoded.dense.every(Number.isFinite))
      return documentFailure("embedding_unavailable");
    const table = await deps.table();
    recheck();
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0) throw new Error("timeout");
    // Await the actual native promise, not a JS timeout race. The caller's
    // bridge/signal has its own deadline; shared ownership must remain until
    // native completion, even if the SDK fails to honor its native timeout.
    const rows = (await table
      .vectorSearch(encoded.dense)
      .distanceType("cosine")
      .where(documentFilter(prefixes))
      .select(["path", "hash", "start_line", "end_line", "_distance"])
      .limit(DOCUMENT_LIMITS.candidates)
      .toArray({ timeoutMs: remainingMs })) as any[];
    recheck();
    const matches = rows.slice(0, DOCUMENT_LIMITS.candidates).flatMap((row) => {
      if (
        typeof row.path !== "string" ||
        !prefixes.some(
          (prefix) =>
            row.path === prefix || row.path.startsWith(prefix + path.sep),
        )
      )
        return [];
      const file = canonicalPointer(row.path, context);
      if (
        !file ||
        !Number.isInteger(row.start_line) ||
        row.start_line < 0 ||
        !Number.isInteger(row.end_line) ||
        row.end_line < row.start_line ||
        !Number.isFinite(row._distance)
      )
        return [];
      const entry = deps.meta(row.path);
      // Only a matching current metadata revision proves this row's digest is bytes.
      const hash =
        entry?.hashVersion === 1 &&
        entry.hasVectors === true &&
        row.hash === entry.hash &&
        /^[a-f0-9]{64}$/.test(row.hash)
          ? { hash: row.hash, hashAlgorithm: "sha256-bytes" }
          : {};
      return [
        {
          path: file,
          startLine: row.start_line + 1,
          endLine: row.end_line + 1,
          score: 1 / (1 + Math.max(0, row._distance)),
          ...hash,
        },
      ];
    });
    return {
      ...base,
      indexState: documentIndexState(deps.indexState(context.wireRoot)),
      matches,
      retrieval: "dense",
      candidateLimit: DOCUMENT_LIMITS.candidates,
    };
  } catch (error) {
    const e = error as Error & { code?: string };
    return documentFailure(
      signal.aborted
        ? signal.reason?.name === "TimeoutError"
          ? "timeout"
          : "cancelled"
        : e.name === "QueryTimeoutError"
          ? "timeout"
          : (e.code ?? e.message),
    );
  }
}
