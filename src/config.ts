import * as os from "node:os";
import * as path from "node:path";

export const MODEL_TIERS: Record<
  string,
  {
    id: string;
    label: string;
    onnxModel: string;
    mlxModel: string;
    vectorDim: number;
    params: string;
  }
> = {
  small: {
    id: "small",
    label: "granite-small (384d, 47M params, fast)",
    onnxModel: "onnx-community/granite-embedding-small-english-r2-ONNX",
    mlxModel: "ibm-granite/granite-embedding-small-english-r2",
    vectorDim: 384,
    params: "47M",
  },
  standard: {
    id: "standard",
    label: "granite-r2 (768d, 149M params, better quality)",
    onnxModel: "onnx-community/granite-embedding-english-r2-ONNX",
    mlxModel: "ibm-granite/granite-embedding-english-r2",
    vectorDim: 768,
    params: "149M",
  },
};

export const DEFAULT_MODEL_TIER = "small";

export const MODEL_IDS = {
  embed: MODEL_TIERS[DEFAULT_MODEL_TIER].onnxModel,
  colbert: "ryandono/mxbai-edge-colbert-v0-17m-onnx-int8",
};

const DEFAULT_WORKER_THREADS = (() => {
  const fromEnv = Number.parseInt(process.env.GMAX_WORKER_THREADS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;

  const cores = os.cpus().length || 1;
  const HARD_CAP = Math.max(4, Math.floor(cores * 0.5));
  return Math.max(1, Math.min(HARD_CAP, cores));
})();

export const CONFIG = {
  VECTOR_DIM: 384,
  COLBERT_DIM: 48,
  MAX_CHUNK_CHARS: 2000,
  MAX_CHUNK_LINES: 75,
  EMBED_BATCH_SIZE: 24,
  WORKER_THREADS: DEFAULT_WORKER_THREADS,
  QUERY_PREFIX: "",
};

export const WORKER_TIMEOUT_MS = Number.parseInt(
  process.env.GMAX_WORKER_TIMEOUT_MS || "60000",
  10,
);

export const WORKER_BOOT_TIMEOUT_MS = Number.parseInt(
  process.env.GMAX_WORKER_BOOT_TIMEOUT_MS || "300000",
  10,
);

export const MAX_WORKER_MEMORY_MB = (() => {
  const fromEnv = Number.parseInt(
    process.env.GMAX_MAX_WORKER_MEMORY_MB ?? "",
    10,
  );
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const HARD_CEILING = 4096; // 4GB max per worker regardless of system RAM
  return Math.min(
    HARD_CEILING,
    Math.max(2048, Math.floor((os.totalmem() / 1024 / 1024) * 0.5)),
  );
})();

const HOME = os.homedir();
const GLOBAL_ROOT = path.join(HOME, ".gmax");

export const PATHS = {
  globalRoot: GLOBAL_ROOT,
  models: path.join(GLOBAL_ROOT, "models"),
  grammars: path.join(GLOBAL_ROOT, "grammars"),
  logsDir: path.join(GLOBAL_ROOT, "logs"),
  daemonSocket: path.join(GLOBAL_ROOT, "daemon.sock"),
  daemonPidFile: path.join(GLOBAL_ROOT, "daemon.pid"),
  daemonLockFile: path.join(GLOBAL_ROOT, "daemon.lock"),
  // Centralized index storage — one database for all indexed directories
  lancedbDir: path.join(GLOBAL_ROOT, "lancedb"),
  cacheDir: path.join(GLOBAL_ROOT, "cache"),
  lmdbPath: path.join(GLOBAL_ROOT, "cache", "meta.lmdb"),
  configPath: path.join(GLOBAL_ROOT, "config.json"),
  lockDir: GLOBAL_ROOT,
};

export const MAX_FILE_SIZE_BYTES = 1024 * 1024 * 2; // 2MB limit for indexing

// Extensions we consider for indexing to avoid binary noise and improve relevance.
export const INDEXABLE_EXTENSIONS: Set<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".cc",
  ".cxx",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".cs",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".sc",
  ".lua",
  ".sh",
  ".sql",
  ".html",
  ".css",
  ".dart",
  ".el",
  ".clj",
  ".ex",
  ".exs",
  ".m",
  ".mm",
  ".f90",
  ".f95",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".md",
  ".mdx",

  ".gitignore",
  ".dockerfile",
  "dockerfile",
  "makefile",
]);
