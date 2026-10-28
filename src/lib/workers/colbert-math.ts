import * as fs from "node:fs";
import * as path from "node:path";
import { inner } from "numkong";
import { MODEL_IDS, PATHS } from "../../config";
import { preparePackedMaxSim } from "./colbert-packed";

const SKIP_IDS = new Map<string, Set<number>>();

function loadSkipIds(modelId: string): Set<number> {
  const cached = SKIP_IDS.get(modelId);
  if (cached) return cached;

  // Check local models first (same logic as orchestrator)
  const PROJECT_ROOT = process.env.GMAX_PROJECT_ROOT
    ? path.resolve(process.env.GMAX_PROJECT_ROOT)
    : process.cwd();
  const localModels = path.join(PROJECT_ROOT, "models");
  const localColbert = path.join(localModels, ...modelId.split("/"));
  const localSkipPath = path.join(localColbert, "skiplist.json");

  // Try local first, then global
  const globalBasePath = path.join(PATHS.models, ...modelId.split("/"));
  const globalSkipPath = path.join(globalBasePath, "skiplist.json");

  const skipPath = fs.existsSync(localSkipPath)
    ? localSkipPath
    : globalSkipPath;

  if (fs.existsSync(skipPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(skipPath, "utf8")) as number[];
      const ids = new Set<number>(parsed.map((n) => Number(n)));
      SKIP_IDS.set(modelId, ids);
      return ids;
    } catch (_e) {
      // fall through to empty set
    }
  }
  const ids = new Set<number>();
  SKIP_IDS.set(modelId, ids);
  return ids;
}

export function maxSim(
  queryEmbeddings: number[][] | Float32Array[],
  docEmbeddings: number[][] | Float32Array[],
  docTokenIds?: number[],
  modelId = MODEL_IDS.colbert,
): number {
  if (queryEmbeddings.length === 0 || docEmbeddings.length === 0) {
    return 0;
  }
  return createMaxSimScorer(queryEmbeddings, modelId)(
    docEmbeddings,
    docTokenIds,
  );
}

/** Prepare one query for synchronous scoring of a document batch. */
export function createMaxSimScorer(
  queryEmbeddings: number[][] | Float32Array[],
  modelId = MODEL_IDS.colbert,
): (document: number[][] | Float32Array[], tokenIds?: number[]) => number {
  if (queryEmbeddings.length === 0) return () => 0;
  const qVecs = queryEmbeddings.map((v) =>
    v instanceof Float32Array ? v : new Float32Array(v),
  );
  // Packing overhead outweighs batching for tiny queries.
  const packed = qVecs.length >= 4 ? preparePackedMaxSim(qVecs) : undefined;
  const skipIds = loadSkipIds(modelId);
  return (docEmbeddings, docTokenIds) => {
    const dTokenIds =
      docTokenIds && docTokenIds.length === docEmbeddings.length
        ? docTokenIds
        : null;
    // Filter once per document rather than once for every query token. Keep
    // the original views: ordinary 48d pairs need no subarray allocations.
    const dVecs: Float32Array[] = [];
    for (let idx = 0; idx < docEmbeddings.length; idx++) {
      const tokenId = dTokenIds ? dTokenIds[idx] : null;
      if (tokenId !== null && skipIds.has(Number(tokenId))) continue;
      const vec = docEmbeddings[idx];
      dVecs.push(vec instanceof Float32Array ? vec : new Float32Array(vec));
    }
    if (dVecs.length === 0) return 0;
    const packedScore = packed?.(dVecs);
    if (packedScore !== undefined) return packedScore;

    let totalScore = 0;
    for (const qVec of qVecs) {
      let maxDotProduct = -Infinity;
      for (const dVec of dVecs) {
        const dot =
          qVec.length === dVec.length
            ? inner(qVec, dVec)
            : inner(
                qVec.subarray(0, Math.min(qVec.length, dVec.length)),
                dVec.subarray(0, Math.min(qVec.length, dVec.length)),
              );
        if (dot > maxDotProduct) maxDotProduct = dot;
      }
      if (maxDotProduct === -Infinity) maxDotProduct = 0;
      totalScore += maxDotProduct;
    }

    return totalScore;
  };
}

export function cosineSim(
  a: number[] | Float32Array,
  b: number[] | Float32Array,
): number {
  const aVec = a instanceof Float32Array ? a : new Float32Array(a);
  const bVec = b instanceof Float32Array ? b : new Float32Array(b);

  const dim = Math.min(aVec.length, bVec.length);
  if (aVec.length !== bVec.length) {
    return inner(aVec.subarray(0, dim), bVec.subarray(0, dim));
  }
  return inner(aVec, bVec);
}
