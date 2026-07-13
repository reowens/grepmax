type MetadataPrimitive = string | number | boolean | null | undefined;
type MetadataObject = { [key: string]: MetadataValue };
type MetadataArray = MetadataValue[];
type MetadataValue = MetadataPrimitive | MetadataArray | MetadataObject;
type MetadataRecord = Record<string, MetadataValue>;

export type PreparedChunk = {
  id: string;
  path: string;
  hash: string;
  content: string;
  start_line: number;
  end_line: number;
  chunk_index?: number;
  is_anchor?: boolean;
  context_prev?: string;
  context_next?: string;
  chunk_type?: string;
  display_text?: string;
  complexity?: number;
  is_exported?: boolean;
  defined_symbols?: string[];
  referenced_symbols?: string[];
  /** Capitalized symbols referenced in type position (`: T`, `<T>`, `as T`).
   * Kept separate from referenced_symbols so it never inflates the call-edge
   * count that feeds search ranking / role classification; navigation consumers
   * (getCallers, dead, impact, audit) union the two. */
  type_referenced_symbols?: string[];
  /** Names called via member syntax (`obj.method()`). Recorded additively —
   * these names are also in referenced_symbols, so recall/ranking are unchanged.
   * Dormant substrate for a future receiver-aware call resolver. */
  member_referenced_symbols?: string[];
  imports?: string[];
  exports?: string[];
  role?: string;
  parent_symbol?: string;
  file_skeleton?: string;
  summary?: string;
};

export type VectorRecord = PreparedChunk & {
  vector: Float32Array | number[];
  colbert: Int8Array | Buffer | number[];
  colbert_scale: number;
  pooled_colbert_48d?: Float32Array | number[];
  doc_token_ids?: number[] | Int32Array;
} & Record<string, unknown>;

export interface FileMetadata extends MetadataRecord {
  path: string;
  hash: string;
  is_anchor?: boolean;
}

export interface ChunkGeneratedMetadata extends MetadataRecord {
  start_line?: number;
  end_line?: number;
  num_lines?: number;
  type?: string;
}

export interface ChunkType extends MetadataRecord {
  type: "text" | "image_url" | "audio_url" | "video_url";
  text?: string;
  score: number;
  confidence?: "High" | "Medium" | "Low";
  metadata?: FileMetadata;
  generated_metadata?: ChunkGeneratedMetadata;
  chunk_index?: number;
  complexity?: number;
  is_exported?: boolean;
  defined_symbols?: string[];
  referenced_symbols?: string[];
  type_referenced_symbols?: string[];
  member_referenced_symbols?: string[];
  imports?: string[];
  exports?: string[];
  role?: string;
  parent_symbol?: string;
  summary?: string;
  context?: string[];
  scoreBreakdown?: ScoreBreakdown;
}

export interface ScoreBreakdown {
  rerank: number;
  fused: number;
  boost: number;
  normalized: number;
  [key: string]: MetadataValue;
}

export interface SearchResponse {
  data: ChunkType[];
  warnings?: string[];
}

export interface SearchFilter {
  file?: string;
  exclude?: string;
  excludePrefixes?: string[];
  inPrefixes?: string[];
  language?: string;
  role?: string;
  projectRoots?: string[];
  project_roots?: string;
  exclude_project_roots?: string;
  def?: string;
  ref?: string;
  [key: string]: MetadataValue;
}
