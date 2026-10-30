import { createHash } from "node:crypto";
import type {
  HistoryChunk,
  HistoryChunkOptions,
  HistoryFilter,
  HistoryHit,
  HistoryQuery,
  HistoryRecord,
  HistorySegment,
} from "./contract";

const key = (kind: string, value: unknown): string =>
  `history:v1:${kind}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer`);
}

function timestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function validateHistoryRecord(record: HistoryRecord): void {
  if (!record || record.schemaVersion !== 1)
    throw new Error("Unsupported history schemaVersion");
  for (const field of [
    "sessionKey",
    "turnKey",
    "provider",
    "text",
    "sourceLocator",
    "sourceRevision",
  ] as const) {
    if (typeof record[field] !== "string")
      throw new Error(`History ${field} must be a string`);
  }
  if (record.machine !== null && typeof record.machine !== "string")
    throw new Error("History machine must be a string or null");
  if (!record.sessionKey || !record.turnKey || !record.sourceLocator)
    throw new Error("History identity and sourceLocator must be nonempty");
  if (!["him", "assistant", "tool"].includes(record.speaker))
    throw new Error("Invalid history speaker");
  if (record.at !== null && !timestamp(record.at))
    throw new Error("History at must be Unix milliseconds or null");
  if (
    typeof record.truncated !== "boolean" ||
    !Array.isArray(record.omissions) ||
    record.omissions.some((v) => typeof v !== "string")
  ) {
    throw new Error("History truncation/omissions must be explicit");
  }
  for (const field of [
    "project",
    "agentKey",
    "parentSessionKey",
    "continuationOf",
  ] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string")
      throw new Error(`Invalid history ${field}`);
  }
  if (
    record.plans !== undefined &&
    (!Array.isArray(record.plans) ||
      record.plans.some((v) => typeof v !== "string"))
  )
    throw new Error("Invalid history plans");
  if (
    record.segmentIndex !== undefined &&
    (!Number.isSafeInteger(record.segmentIndex) || record.segmentIndex < 0)
  )
    throw new Error("Invalid history segmentIndex");
}

const recordIdentity = (record: HistoryRecord): unknown[] => [
  record.sessionKey,
  record.turnKey,
  record.segmentIndex ?? null,
];

/** Input order is authoritative, never inferred from missing or nonmonotonic dates.
 * Each user turn starts an exchange in its session/agent stream. Orphan replies
 * form their own exchange. Oversized exchanges retain context through links.
 * Callers supply a bounded batch; this is not a corpus reader or index writer.
 */
export function chunkHistoryRecords(
  records: Iterable<HistoryRecord>,
  options: HistoryChunkOptions = {},
): HistoryChunk[] {
  const maxTextChars = options.maxTextChars ?? 4096;
  const maxSegments = options.maxSegments ?? 16;
  positiveInteger(maxTextChars, "maxTextChars");
  positiveInteger(maxSegments, "maxSegments");
  const streams = new Map<string, HistoryRecord[][]>();
  const identities = new Set<string>();
  for (const record of records) {
    validateHistoryRecord(record);
    const identity = JSON.stringify(recordIdentity(record));
    if (identities.has(identity))
      throw new Error(
        "Duplicate history identity; reconcile revisions before chunking",
      );
    identities.add(identity);
    const streamKey = JSON.stringify([
      record.sessionKey,
      record.agentKey ?? null,
      record.parentSessionKey ?? null,
    ]);
    const exchanges = streams.get(streamKey) ?? [];
    if (
      !exchanges.length ||
      (record.speaker === "him" && record.continuationOf === undefined)
    )
      exchanges.push([]);
    exchanges[exchanges.length - 1].push(record);
    streams.set(streamKey, exchanges);
  }
  const chunks: HistoryChunk[] = [];
  for (const exchanges of streams.values()) {
    for (const exchange of exchanges) {
      const exchangeKey = key("exchange", recordIdentity(exchange[0]));
      let segments: HistorySegment[] = [];
      let chars = 0;
      let previousChunkKey: string | undefined;
      const flush = (): void => {
        if (!segments.length) return;
        const chunkKey = key(
          "chunk",
          segments.map((s) => s.segmentKey),
        );
        const embeddingText = segments
          .map((s) => `${s.speaker}: ${s.text}`)
          .join("\n");
        chunks.push({
          schemaVersion: 1,
          chunkKey,
          exchangeKey,
          previousChunkKey,
          segments,
          embeddingText,
          embeddingKey: key("embedding", embeddingText),
        });
        previousChunkKey = chunkKey;
        segments = [];
        chars = 0;
      };
      for (const record of exchange) {
        let start = 0;
        let partIndex = 0;
        let previousSegmentKey: string | undefined;
        do {
          if (chars === maxTextChars || segments.length === maxSegments)
            flush();
          let end = Math.min(record.text.length, start + maxTextChars - chars);
          // Keep valid surrogate pairs intact where the configured bound permits it.
          if (
            end < record.text.length &&
            end > start &&
            /[\uD800-\uDBFF]/.test(record.text[end - 1]) &&
            /[\uDC00-\uDFFF]/.test(record.text[end])
          ) {
            if (end - start > 1) end--;
            else if (segments.length && maxTextChars > 1) {
              flush();
              continue;
            }
          }
          const segmentKey = key("segment", [
            ...recordIdentity(record),
            start,
            end,
          ]);
          segments.push({
            ...record,
            omissions: [...record.omissions],
            ...(record.plans === undefined ? {} : { plans: [...record.plans] }),
            text: record.text.slice(start, end),
            segmentKey,
            textStart: start,
            textEnd: end,
            partIndex,
            previousSegmentKey,
          });
          chars += end - start;
          previousSegmentKey = segmentKey;
          partIndex++;
          start = end;
        } while (start < record.text.length);
      }
      flush();
    }
  }
  return chunks;
}

function validateFilter(filter: HistoryFilter): void {
  for (const field of ["since", "until"] as const) {
    if (filter[field] !== undefined && !timestamp(filter[field]))
      throw new Error(`Invalid history ${field}`);
  }
  if (
    filter.since !== undefined &&
    filter.until !== undefined &&
    filter.since >= filter.until
  )
    throw new Error("History since must precede until");
  for (const field of [
    "providers",
    "projects",
    "machines",
    "speakers",
  ] as const) {
    const values = filter[field];
    if (
      values !== undefined &&
      (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
    )
      throw new Error(`Invalid history ${field}`);
  }
  if (filter.speakers?.some((v) => !["him", "assistant", "tool"].includes(v)))
    throw new Error("Invalid history speakers");
}

function eligible(record: HistoryRecord, filter: HistoryFilter): boolean {
  return (
    (filter.since === undefined ||
      (record.at !== null && record.at >= filter.since)) &&
    (filter.until === undefined ||
      (record.at !== null && record.at < filter.until)) &&
    (filter.providers === undefined ||
      filter.providers.includes(record.provider)) &&
    (filter.machines === undefined ||
      (record.machine !== null && filter.machines.includes(record.machine))) &&
    (filter.projects === undefined ||
      (record.project !== undefined &&
        filter.projects.includes(record.project))) &&
    (filter.speakers === undefined || filter.speakers.includes(record.speaker))
  );
}

/** All predicates must match the same original turn. Empty lists match nothing. */
export function isHistoryRecordEligible(
  record: HistoryRecord,
  filter: HistoryFilter,
): boolean {
  validateHistoryRecord(record);
  validateFilter(filter);
  return eligible(record, filter);
}

/** Pure query seam: score only eligible original slices, then truncate. The caller
 * must supply the complete bounded candidate universe, not pre-truncated dense
 * hits. A later store adapter must push the same eligibility ahead of its limits.
 * Returned chunks include explicitly identified surrounding context, which may
 * itself fall outside the filter. No embeddings or runtime services are invoked.
 */
export function rankHistoryChunks(
  chunks: Iterable<HistoryChunk>,
  query: HistoryQuery,
  score: (eligibleSegments: readonly HistorySegment[]) => number,
): HistoryHit[] {
  if (query.schemaVersion !== 1)
    throw new Error("Unsupported history query schemaVersion");
  positiveInteger(query.topK, "topK");
  validateFilter(query);
  const hits: HistoryHit[] = [];
  for (const chunk of chunks) {
    if (chunk.schemaVersion !== 1)
      throw new Error("Unsupported history chunk schemaVersion");
    const matches = chunk.segments.filter((s) => {
      validateHistoryRecord(s);
      return eligible(s, query);
    });
    if (!matches.length) continue;
    const value = score(matches);
    if (!Number.isFinite(value))
      throw new Error("History score must be finite");
    hits.push({
      chunk,
      score: value,
      eligibleSegmentKeys: matches.map((s) => s.segmentKey),
    });
  }
  return hits
    .sort(
      (a, b) =>
        b.score - a.score || a.chunk.chunkKey.localeCompare(b.chunk.chunkKey),
    )
    .slice(0, query.topK);
}
