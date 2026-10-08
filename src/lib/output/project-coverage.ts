import type { ProjectOverview } from "../daemon/rows-handler";

type Coverage = Pick<
  ProjectOverview,
  "chunks" | "files" | "sampled" | "totalChunks"
>;

export function projectCounts(overview: Coverage): string {
  const qualifier = overview.sampled ? "sampled " : "";
  return `${overview.chunks} ${qualifier}chunks • ${overview.files} ${qualifier}files`;
}

export function projectCoverageNotice(overview: Coverage): string | null {
  if (!overview.sampled) return null;
  const total =
    overview.totalChunks === undefined
      ? "total chunk count unavailable"
      : `${overview.totalChunks} total chunks`;
  return `partial: ${overview.chunks} sampled chunks, ${overview.files} sampled files; ${total}; all breakdowns below describe the sample`;
}
