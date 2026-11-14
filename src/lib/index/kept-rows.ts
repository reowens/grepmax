import { createHash } from "node:crypto";
import type { VectorRecord } from "../store/types";
import type { ReusableEmbedding } from "./embedding-reuse";

/**
 * The columns a new row must equal for the stored row to stay in place. That is
 * every stored column except `id`, `hash` (the file revision the row was
 * written at), `display_text` (always stored empty), `summary` (attached later
 * by id, so a kept row keeps its own) and the embedding columns, which are a
 * function of `content` on the active generation.
 */
export const KEPT_ROW_COLUMNS = [
  "path",
  "content",
  "start_line",
  "end_line",
  "chunk_index",
  "is_anchor",
  "context_prev",
  "context_next",
  "chunk_type",
  "complexity",
  "is_exported",
  "defined_symbols",
  "referenced_symbols",
  "type_referenced_symbols",
  "member_referenced_symbols",
  "imports",
  "exports",
  "role",
  "parent_symbol",
  "file_skeleton",
] as const;

export type StoredRow = { id: string; key: string };

/** One file's stored rows as read before it is rewritten. */
export type StoredFileRows = {
  /** Keyed by `embeddingReuseKey(content)`; identical texts share an entry. */
  embeddings: Map<string, ReusableEmbedding>;
  rows: StoredRow[];
};

export type RowWrite = { records: VectorRecord[]; keptIds: string[] };

export interface RowWriter {
  insertBatch(records: VectorRecord[]): Promise<void>;
  deletePaths(paths: string[]): Promise<void>;
  deletePathsExcludingIds(paths: string[], excludeIds: string[]): Promise<void>;
}

const text = (value: unknown) => (value == null ? "" : String(value));
const list = (value: unknown) =>
  value == null ? [] : Array.from(value as Iterable<unknown>, String);

/**
 * `KEPT_ROW_COLUMNS` as `insertBatch` stores them, so a prepared record and a
 * row read back from Lance compare equal. `complexity` is a Float32 column.
 */
export function keptRowFields(row: Record<string, unknown>) {
  return {
    path: text(row.path),
    content: text(row.content),
    start_line: Number(row.start_line),
    end_line: Number(row.end_line),
    chunk_index: row.chunk_index == null ? null : Number(row.chunk_index),
    is_anchor: row.is_anchor === true,
    context_prev: text(row.context_prev),
    context_next: text(row.context_next),
    chunk_type: text(row.chunk_type),
    complexity:
      typeof row.complexity === "number" ? Math.fround(row.complexity) : null,
    is_exported: row.is_exported === true,
    defined_symbols: list(row.defined_symbols),
    referenced_symbols: list(row.referenced_symbols),
    type_referenced_symbols: list(row.type_referenced_symbols),
    member_referenced_symbols: list(row.member_referenced_symbols),
    imports: list(row.imports),
    exports: list(row.exports),
    role: text(row.role),
    parent_symbol: text(row.parent_symbol),
    file_skeleton: text(row.file_skeleton),
  };
}

export function keptRowKey(row: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(keptRowFields(row)))
    .digest("hex");
}

/**
 * Split a file's new records into those to insert and the stored rows they
 * equal. Only records whose embedding was reused can be kept, so a kept row is
 * on the generation that reuse already requires. Each stored row matches at
 * most one record: 2 identical chunks keep 2 rows, and any further copy (left
 * by an insert whose delete never ran) is deleted with the file's other rows.
 */
export function keepStoredRows(
  records: VectorRecord[],
  reusedIndexes: number[],
  stored: StoredRow[] | undefined,
): RowWrite {
  if (!stored?.length || !reusedIndexes.length) return { records, keptIds: [] };
  const idsByKey = new Map<string, string[]>();
  for (const row of stored) {
    const ids = idsByKey.get(row.key);
    if (ids) ids.push(row.id);
    else idsByKey.set(row.key, [row.id]);
  }
  const reused = new Set(reusedIndexes);
  const write: RowWrite = { records: [], keptIds: [] };
  records.forEach((record, index) => {
    const id = reused.has(index)
      ? idsByKey.get(keptRowKey(record))?.pop()
      : undefined;
    if (id) write.keptIds.push(id);
    else write.records.push(record);
  });
  return write;
}

/**
 * Insert first, then delete every other row of `deletes`. Kept and inserted
 * ids are excluded from the delete, so a path with only kept rows keeps them.
 * `deletes` may be resolved after the insert, for callers that recheck paths.
 */
export async function writeRows(
  db: RowWriter,
  rows: RowWrite,
  deletes: string[] | (() => Promise<string[]>),
): Promise<void> {
  const keepIds = [...rows.records.map((r) => r.id), ...rows.keptIds];
  if (rows.records.length > 0) await db.insertBatch(rows.records);
  const paths = typeof deletes === "function" ? await deletes() : deletes;
  if (paths.length === 0) return;
  if (keepIds.length > 0) await db.deletePathsExcludingIds(paths, keepIds);
  else await db.deletePaths(paths);
}
