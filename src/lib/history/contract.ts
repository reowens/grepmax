/** Portable normalizer interchange. Locators are evidence references, never filesystem paths. */
export interface HistoryRecord {
  readonly schemaVersion: 1;
  readonly sessionKey: string;
  readonly turnKey: string;
  readonly provider: string;
  readonly machine: string;
  readonly speaker: "him" | "assistant" | "tool";
  readonly at: number | null;
  readonly text: string;
  readonly sourceLocator: string;
  readonly sourceRevision: string;
  readonly truncated: boolean;
  readonly omissions: readonly string[];
  readonly project?: string;
  readonly plans?: readonly string[];
  readonly agentKey?: string;
  readonly parentSessionKey?: string;
  readonly segmentIndex?: number;
  readonly continuationOf?: string;
}

export interface HistorySegment extends HistoryRecord {
  readonly segmentKey: string;
  /** UTF-16 offsets into the input record's exact text; concatenation is lossless. */
  readonly textStart: number;
  readonly textEnd: number;
  readonly partIndex: number;
  /** Adapter-generated link; input segmentIndex/continuationOf stay unchanged. */
  readonly previousSegmentKey?: string;
}

export interface HistoryChunk {
  readonly schemaVersion: 1;
  readonly chunkKey: string;
  readonly exchangeKey: string;
  readonly previousChunkKey?: string;
  readonly segments: readonly HistorySegment[];
  /** Speaker-labelled original slices only. Metadata changes do not change embeddingKey. */
  readonly embeddingText: string;
  readonly embeddingKey: string;
}

export interface HistoryChunkOptions {
  /** Bounds sum of original text UTF-16 units, excluding speaker labels and metadata. */
  readonly maxTextChars?: number;
  readonly maxSegments?: number;
}

export interface HistoryFilter {
  /** Inclusive since, exclusive until, using individual turn times. Unknown dates fail bounds. */
  readonly since?: number;
  readonly until?: number;
  readonly providers?: readonly string[];
  readonly projects?: readonly string[];
  readonly machines?: readonly string[];
  readonly speakers?: readonly HistoryRecord["speaker"][];
}

export interface HistoryQuery extends HistoryFilter {
  readonly schemaVersion: 1;
  readonly topK: number;
}

export interface HistoryHit {
  readonly chunk: HistoryChunk;
  readonly score: number;
  /** Only these segments satisfy all filters; other segments are labelled context. */
  readonly eligibleSegmentKeys: readonly string[];
}
