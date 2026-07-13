import type { ProjectEntry } from "../utils/project-registry";
import {
  compareEmbeddingGeneration,
  type EmbeddingGenerationConfig,
  type EmbeddingIdentityState,
  resolveEmbeddingGeneration,
} from "./embedding-generation";
import type { GlobalConfig } from "./index-config";

export interface ProjectEmbeddingStatus {
  configured: Readonly<EmbeddingGenerationConfig>;
  built: Readonly<EmbeddingGenerationConfig> | null;
  state: EmbeddingIdentityState | "unbuilt";
}

export function projectEmbeddingStatus(
  project: ProjectEntry | undefined,
  config: GlobalConfig,
): ProjectEmbeddingStatus {
  const configured = resolveEmbeddingGeneration(config);
  if (!project || project.status !== "indexed") {
    return { configured, built: null, state: "unbuilt" };
  }
  const comparison = compareEmbeddingGeneration(project, configured);
  return { configured, ...comparison };
}

export function embeddingFingerprintLabel(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}

export function countLegacyEmbeddingProjects(
  projects: readonly ProjectEntry[],
  config: GlobalConfig,
): number {
  return projects.filter(
    (project) => projectEmbeddingStatus(project, config).state === "legacy",
  ).length;
}

export function formatLegacyEmbeddingNotice(
  count: number,
  options?: { agent?: boolean },
): string | null {
  if (count === 0) return null;
  if (options?.agent) {
    return `legacy_embedding\tcount=${count}\tstate=compatible_inferred\tfix=gmax index`;
  }
  const projects = count === 1 ? "project" : "projects";
  return `INFO  Legacy embedding: ${count} ${projects} compatible but inferred; run 'gmax index' in each project to persist exact identity.`;
}

export function assertEmbeddingSearchCompatible(
  projects: readonly ProjectEntry[],
  config: GlobalConfig,
): void {
  const stale = projects.filter(
    (project) => projectEmbeddingStatus(project, config).state === "stale",
  );
  if (stale.length === 0) return;
  throw new Error(
    `embedding generation mismatch for ${stale.map((project) => project.name).join(", ")}; run gmax repair --rebuild to rebuild the whole corpus`,
  );
}
