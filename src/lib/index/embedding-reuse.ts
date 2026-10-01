import { createHash } from "node:crypto";

/**
 * Embeddings of a chunk already in the store, offered back to the worker so an
 * edit to a large file only embeds the chunks whose text changed. A one-line
 * save to a 685-chunk plan doc used to re-run ColBERT over every chunk (~25s of
 * CPU); the embedding inputs are the chunk text alone, so an unchanged chunk's
 * stored vectors are exactly what re-embedding it would produce.
 *
 * Only offered for a watched project, whose rows are on the active embedding
 * generation — a stale project is refused before it is watched.
 */
export type ReusableEmbedding = {
  vector: Float32Array;
  colbert: Buffer;
  colbert_scale: number;
  pooled_colbert_48d?: Float32Array;
  doc_token_ids?: Int32Array;
};

/** Keyed by the exact text passed to the embedder (`PreparedChunk.content`). */
export function embeddingReuseKey(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function unwrap(val: unknown): unknown {
  if (
    val &&
    !ArrayBuffer.isView(val) &&
    typeof (val as any).toArray === "function"
  ) {
    return (val as any).toArray();
  }
  return val;
}

// Copies rather than views: an Arrow view pins its whole record batch buffer.
export function toFloat32(val: unknown): Float32Array {
  const v = unwrap(val);
  if (v instanceof Float32Array) return v.slice();
  if (ArrayBuffer.isView(v) || Array.isArray(v)) {
    return Float32Array.from(v as ArrayLike<number>);
  }
  return new Float32Array(0);
}

export function toInt32(val: unknown): Int32Array {
  const v = unwrap(val);
  if (v instanceof Int32Array) return v.slice();
  if (ArrayBuffer.isView(v) || Array.isArray(v)) {
    return Int32Array.from(v as ArrayLike<number>);
  }
  return new Int32Array(0);
}

export function toBytes(val: unknown): Buffer {
  const v = unwrap(val);
  if (ArrayBuffer.isView(v)) {
    return Buffer.from(
      new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice(),
    );
  }
  if (Array.isArray(v)) return Buffer.from(v as number[]);
  return Buffer.alloc(0);
}
