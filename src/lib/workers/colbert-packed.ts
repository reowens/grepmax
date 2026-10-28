import { DType, dotsPack, dotsPacked, inner, Matrix } from "numkong";

// The deployed ColBERT model uses 48 dimensions and at most 512 document tokens.
// Keep temporary matrices bounded and leave other shapes to the pairwise path.
const DIMENSIONS = 48;
const MAX_QUERY_TOKENS = 128;
const MAX_DOCUMENT_TOKENS = 512;

export function preparePackedMaxSim(
  query: Float32Array[],
): ((document: Float32Array[]) => number | undefined) | undefined {
  if (
    query.length === 0 ||
    query.length > MAX_QUERY_TOKENS ||
    query.some((row) => row.length !== DIMENSIONS)
  )
    return undefined;

  const queryData = new Float32Array(query.length * DIMENSIONS);
  const queryNorms = new Float64Array(query.length);
  for (let i = 0; i < query.length; i++) {
    queryData.set(query[i], i * DIMENSIONS);
    for (const value of query[i]) {
      if (!Number.isFinite(value)) return undefined;
      queryNorms[i] += Math.abs(value);
    }
  }
  // Pack the query once for the whole rerank batch, not once per document.
  const packedQuery = dotsPack(
    new Matrix(queryData.buffer, 0, DType.F32, query.length, DIMENSIONS),
  );
  let documentData = new Float32Array(0);
  let scores = new Float64Array(0);

  return (document) => {
    if (
      document.length < 8 ||
      document.length > MAX_DOCUMENT_TOKENS ||
      document.some((row) => row.length !== DIMENSIONS)
    )
      return undefined;

    if (documentData.length < document.length * DIMENSIONS)
      documentData = new Float32Array(document.length * DIMENSIONS);
    if (scores.length < document.length * query.length)
      scores = new Float64Array(document.length * query.length);
    let maxAbs = 0;
    let identicalRows = true;
    for (let i = 0; i < document.length; i++) {
      documentData.set(document[i], i * DIMENSIONS);
      for (const value of document[i]) {
        if (!Number.isFinite(value)) return undefined;
        maxAbs = Math.max(maxAbs, Math.abs(value));
      }
      if (identicalRows && i > 0)
        identicalRows = document[i].every(
          (value, d) => value === document[0][d],
        );
    }
    // Repeated rows have the same winner for every query token. Avoid packing
    // and refining a matrix full of ties (including all-zero documents).
    if (identicalRows)
      return query.reduce((sum, row) => sum + inner(row, document[0]), 0);

    dotsPacked(
      new Matrix(
        documentData.buffer,
        0,
        DType.F32,
        document.length,
        DIMENSIONS,
      ),
      packedQuery,
      new Matrix(scores.buffer, 0, DType.F64, document.length, query.length),
    );

    let total = 0;
    for (let q = 0; q < query.length; q++) {
      if (queryNorms[q] === 0) continue;
      let approximateBest = -Infinity;
      for (let d = 0; d < document.length; d++) {
        const score = scores[d * query.length + q];
        if (!Number.isFinite(score)) return undefined;
        if (score > approximateBest) approximateBest = score;
      }
      // Both kernels accumulate Float32 products in Float64, but can reduce in
      // different orders. Refine every contender within a conservative rounding
      // bound with the original dot kernel, preserving its exact scores/ties.
      // sum(abs(q[d] * doc[d])) <= ||q||_1 * max(abs(document)).
      const tolerance =
        8 * DIMENSIONS * Number.EPSILON * queryNorms[q] * maxAbs;
      let best = -Infinity;
      for (let d = 0; d < document.length; d++) {
        if (scores[d * query.length + q] >= approximateBest - tolerance) {
          const score = inner(query[q], document[d]);
          if (score > best) best = score;
        }
      }
      total += best;
    }
    return total;
  };
}
