// src/config.ts
export const MODEL_IDS = {
  embed: "ryandono/osgrep-coderank-q4", 
  colbert: "ryandono/osgrep-colbert-q8", 
};

export const CONFIG = {
  VECTOR_DIMENSIONS: 768, // CodeRankEmbed
  COLBERT_DIM: 48, // Mxbai-Edge
  // Precise prefix from model card
  QUERY_PREFIX: "Represent this query for searching relevant code: ",
};

export const VECTOR_CACHE_MAX = Number.parseInt(
  process.env.OSGREP_VECTOR_CACHE_MAX || "10000",
  10,
);

export const WORKER_TIMEOUT_MS = Number.parseInt(
  process.env.OSGREP_WORKER_TIMEOUT_MS || "60000",
  10,
);
