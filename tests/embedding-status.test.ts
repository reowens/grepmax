import { describe, expect, it } from "vitest";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";
import {
  assertEmbeddingSearchCompatible,
  formatLegacyEmbeddingNotice,
  projectEmbeddingStatus,
} from "../src/lib/index/embedding-status";
import type { ProjectEntry } from "../src/lib/utils/project-registry";

const config = {
  modelTier: "small",
  vectorDim: 384,
  embedMode: "cpu" as const,
};

function project(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    root: "/work/app",
    name: "app",
    modelTier: "small",
    vectorDim: 384,
    embedMode: "cpu",
    lastIndexed: "2026-07-11T00:00:00.000Z",
    status: "indexed",
    ...overrides,
  };
}

describe("projectEmbeddingStatus", () => {
  it("reports an equivalent unstamped project as legacy", () => {
    expect(projectEmbeddingStatus(project(), config).state).toBe("legacy");
  });

  it("reports an exact persisted generation as current", () => {
    const generation = resolveEmbeddingGeneration(config);
    expect(
      projectEmbeddingStatus(
        project({ embeddingFingerprint: generation.fingerprint }),
        config,
      ).state,
    ).toBe("current");
  });

  it("blocks same-width and different-width stale generations", () => {
    const staleSameWidth = project({
      mlxModel: "custom/old-mlx",
      embeddingFingerprint: undefined,
    });
    const staleWidth = project({
      modelTier: "standard",
      vectorDim: 768,
    });

    expect(() =>
      assertEmbeddingSearchCompatible([staleSameWidth], config),
    ).toThrow(/repair --rebuild/i);
    expect(() => assertEmbeddingSearchCompatible([staleWidth], config)).toThrow(
      /repair --rebuild/i,
    );
  });
});

describe("formatLegacyEmbeddingNotice", () => {
  it("returns no notice when every project has exact identity", () => {
    expect(formatLegacyEmbeddingNotice(0)).toBeNull();
  });

  it("explains that legacy identity is compatible but inferred", () => {
    const notice = formatLegacyEmbeddingNotice(2);
    expect(notice).toContain("2 projects");
    expect(notice).toContain("compatible but inferred");
    expect(notice).toContain("gmax index");
  });

  it("renders a parseable agent record", () => {
    expect(formatLegacyEmbeddingNotice(1, { agent: true })).toBe(
      "legacy_embedding\tcount=1\tstate=compatible_inferred\tfix=gmax index",
    );
  });
});
