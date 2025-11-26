// src/config.ts
export const MODEL_IDS = {
  // Dense encoder: smaller/faster to keep indexing snappy
  embed: "onnx-community/granite-embedding-30m-english-ONNX",
  // ColBERT reranker (custom q8 build with ONNX available)
  colbert: "ryandono/osgrep-colbert-q8",
};

export const CONFIG = {
  VECTOR_DIMENSIONS: 384, 
  COLBERT_DIM: 48, // Mxbai-Edge
  // Precise prefix from model card
  QUERY_PREFIX: "",
};

export const WORKER_TIMEOUT_MS = Number.parseInt(
  process.env.OSGREP_WORKER_TIMEOUT_MS || "60000",
  10,
);
