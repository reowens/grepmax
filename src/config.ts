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
  // Bump when chunk metadata semantics change in a way that requires a full
  // reindex to take effect. Must equal the latest entry's `v` in
  // CHUNKER_VERSION_HISTORY below — see that list for per-version severity and
  // the user-facing note rendered by `gmax doctor` and the staleness hint.
  CHUNKER_VERSION: 3,
};

/**
 * Per-version record of what changed in the chunker and how much it matters to
 * an already-built index. `severity` drives tone: an "additive" change only
 * adds new metadata (older indexes under-cover but aren't wrong), while a
 * "breaking" change means older indexes carry incorrect metadata until a
 * reindex. The `note` is shown verbatim to the user for the versions their
 * index is missing. CONFIG.CHUNKER_VERSION must equal the highest `v` here.
 */
export const CHUNKER_VERSION_HISTORY: ReadonlyArray<{
  v: number;
  severity: "additive" | "breaking";
  note: string;
}> = [
  {
    v: 2,
    severity: "breaking",
    note: "sub-chunk symbol scoping; graph overcounted callers before this.",
  },
  {
    v: 3,
    severity: "additive",
    note: "type-position edges; dead/trace miss type-only callers until reindex.",
  },
];

export interface ChunkerGap {
  /** The version the index was last built with (1 if never stamped). */
  fromVersion: number;
  /** The current chunker version it should be at. */
  toVersion: number;
  /** "breaking" if any missed version was breaking, else "additive". */
  severity: "additive" | "breaking";
  /** User-facing notes for every version the index is missing. */
  notes: string[];
}

/**
 * Describe the gap between an index's stamped chunker version and the current
 * one, or null when the index is already current. Shared by `gmax doctor` and
 * the query-time staleness hint so both render the same severity + notes.
 */
export function describeChunkerGap(
  indexedVersion: number | undefined,
): ChunkerGap | null {
  const fromVersion = indexedVersion ?? 1;
  if (fromVersion >= CONFIG.CHUNKER_VERSION) return null;
  const missed = CHUNKER_VERSION_HISTORY.filter(
    (h) => h.v > fromVersion && h.v <= CONFIG.CHUNKER_VERSION,
  );
  const severity = missed.some((h) => h.severity === "breaking")
    ? "breaking"
    : "additive";
  return {
    fromVersion,
    toVersion: CONFIG.CHUNKER_VERSION,
    severity,
    notes: missed.map((h) => h.note),
  };
}

/** A built index's embedding identity — the model tier and vector width its
 * vectors were produced with. Sourced from `ProjectEntry.{modelTier,vectorDim}`
 * (registry) or `IndexConfig`. Fields are optional so partial/legacy records
 * fall back to the tier's canonical dim (or CONFIG.VECTOR_DIM). */
export interface EmbeddingIdentity {
  modelTier?: string;
  vectorDim?: number;
}

export interface EmbeddingGap {
  /** Model tier the index was built with. */
  fromModel: string;
  /** Model tier the current global config would build with. */
  toModel: string;
  /** Vector width of the stored index. */
  fromDim: number;
  /** Vector width the current config produces. */
  toDim: number;
  /** True when the width differs — stored vectors and a fresh query embedding
   * are structurally incompatible (the shared LanceDB table silently pads or
   * truncates to its fixed width, so scores are garbage). */
  dimChanged: boolean;
  /** "breaking" when the dim changed (search invalid until re-embed); "additive"
   * for a same-width model swap (search still runs, just mixed-model quality). */
  severity: "additive" | "breaking";
}

/**
 * Describe the gap between an index's stored embedding identity (model tier +
 * vector dim) and the current global config, or null when they already agree.
 *
 * A dimension change is `breaking`: vectors of differing widths cannot be
 * compared, and the single fixed-dim `chunks` table silently pads/truncates a
 * mismatched query embedding, yielding meaningless scores. A same-width model
 * swap is `additive`: the stored vectors are a different model's output but the
 * same width, so search keeps working with mixed-model quality until a re-embed.
 *
 * Mirrors describeChunkerGap so `gmax doctor` and the query-time hint render the
 * same severity. Pure over MODEL_TIERS — callers pass the current identity (read
 * from the global config) so this module stays free of config I/O.
 */
export function describeEmbeddingGap(
  stored: EmbeddingIdentity,
  current: EmbeddingIdentity,
): EmbeddingGap | null {
  const fromModel = stored.modelTier ?? DEFAULT_MODEL_TIER;
  const toModel = current.modelTier ?? DEFAULT_MODEL_TIER;
  const fromDim =
    stored.vectorDim ?? MODEL_TIERS[fromModel]?.vectorDim ?? CONFIG.VECTOR_DIM;
  const toDim =
    current.vectorDim ?? MODEL_TIERS[toModel]?.vectorDim ?? CONFIG.VECTOR_DIM;

  const dimChanged = fromDim !== toDim;
  const modelChanged = fromModel !== toModel;
  if (!dimChanged && !modelChanged) return null;

  return {
    fromModel,
    toModel,
    fromDim,
    toDim,
    dimChanged,
    severity: dimChanged ? "breaking" : "additive",
  };
}

/**
 * The single sanctioned recovery for a physical table-width mismatch. The shared
 * `chunks` table is fixed-width at creation, so a tier/dim change strands it at
 * the old width and every write throws. A per-project `gmax index --reset` only
 * deletes rows — it can't change the shared table's width — so the real fix is a
 * global drop-and-rebuild. doctor, the insertBatch failure, and the staleness
 * hint all point here so the guidance never contradicts itself.
 */
export const REBUILD_COMMAND = "gmax repair --rebuild";

export interface SchemaDimGap {
  /** Physical width of the `vector` column in the on-disk `chunks` table. */
  tableDim: number;
  /** Vector width the current global config produces. */
  configDim: number;
}

/**
 * Describe the gap between the LanceDB table's PHYSICAL `vector` width and the
 * width the current global config would produce, or null when they agree (or no
 * table exists yet). This is distinct from {@link describeEmbeddingGap}: that one
 * compares the project REGISTRY's recorded `{modelTier, vectorDim}` to config
 * (logical drift, fixable per project), while this compares the actual on-disk
 * table schema to config (physical drift — every write throws until a global
 * rebuild). A table can match the registry yet still be physically stranded, so
 * doctor reports both independently.
 */
export function describeSchemaDimGap(
  tableDim: number | null | undefined,
  configDim: number,
): SchemaDimGap | null {
  if (tableDim == null) return null; // no table on disk yet — nothing to compare
  if (tableDim === configDim) return null;
  return { tableDim, configDim };
}

/** Stable, tab-delimited doctor `--agent` row for a physical schema-dim
 * mismatch. Kept here (pure) so the wire format is testable without running the
 * full doctor command. */
export function schemaDimAgentRow(gap: SchemaDimGap): string {
  return [
    "schema_dim_mismatch",
    `table_dim=${gap.tableDim}`,
    `current_dim=${gap.configDim}`,
    `fix=${REBUILD_COMMAND}`,
  ].join("\t");
}

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
  // Written by a daemon while it is gracefully shutting down (draining workers,
  // closing LanceDB). A successor's killStaleProcesses() respects this so it
  // never SIGKILLs a peer mid-cleanup once the peer has already dropped its
  // socket/PID/lock liveness markers.
  daemonDrainingFile: path.join(GLOBAL_ROOT, "daemon.draining"),
  // Centralized index storage — one database for all indexed directories
  lancedbDir: path.join(GLOBAL_ROOT, "lancedb"),
  cacheDir: path.join(GLOBAL_ROOT, "cache"),
  lmdbPath: path.join(GLOBAL_ROOT, "cache", "meta.lmdb"),
  configPath: path.join(GLOBAL_ROOT, "config.json"),
  lockDir: GLOBAL_ROOT,
  // LLM server (llama-server)
  llmPidFile: path.join(GLOBAL_ROOT, "llm-server.pid"),
  llmLogFile: path.join(GLOBAL_ROOT, "logs", "llm-server.log"),
};

export const MAX_FILE_SIZE_BYTES = 1024 * 1024 * 2; // 2MB limit for indexing

// Disk pressure thresholds — writes are suspended below critical, compaction limited below low
export const DISK_CRITICAL_BYTES = (() => {
  const gb = Number.parseFloat(process.env.GMAX_DISK_CRITICAL_GB ?? "5");
  return (Number.isFinite(gb) && gb > 0 ? gb : 5) * 1024 * 1024 * 1024;
})();

export const DISK_LOW_BYTES = (() => {
  const gb = Number.parseFloat(process.env.GMAX_DISK_LOW_GB ?? "20");
  return (Number.isFinite(gb) && gb > 0 ? gb : 20) * 1024 * 1024 * 1024;
})();

// Trigger compaction when small (uncompacted) fragment count exceeds this
export const FRAGMENT_COMPACT_THRESHOLD = 50;

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
