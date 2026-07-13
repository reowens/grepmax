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
