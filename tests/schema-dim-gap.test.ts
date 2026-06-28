import { describe, expect, it } from "vitest";
import {
  describeEmbeddingGap,
  describeSchemaDimGap,
  REBUILD_COMMAND,
  schemaDimAgentRow,
} from "../src/config";

describe("describeSchemaDimGap", () => {
  it("flags a physical 384d table when config expects 768d", () => {
    expect(describeSchemaDimGap(384, 768)).toEqual({
      tableDim: 384,
      configDim: 768,
    });
  });

  it("returns null when the table width matches config", () => {
    expect(describeSchemaDimGap(768, 768)).toBeNull();
  });

  it("returns null when there is no table on disk yet", () => {
    expect(describeSchemaDimGap(null, 768)).toBeNull();
    expect(describeSchemaDimGap(undefined, 768)).toBeNull();
  });
});

describe("schemaDimAgentRow", () => {
  it("emits a stable tab-delimited machine-readable row", () => {
    const row = schemaDimAgentRow({ tableDim: 384, configDim: 768 });
    expect(row).toBe(
      `schema_dim_mismatch\ttable_dim=384\tcurrent_dim=768\tfix=${REBUILD_COMMAND}`,
    );
  });

  it("points at the global rebuild as the recovery command", () => {
    // The whole point of the "global rebuild" strategy: a per-project reset
    // can't reshape the shared fixed-width table. Guard the wording so doctor,
    // the insertBatch failure, and the staleness hint never drift apart.
    expect(REBUILD_COMMAND).toBe("gmax repair --rebuild");
  });
});

describe("physical schema drift is distinct from registry embedding drift", () => {
  it("flags a stranded table even when the registry matches config", () => {
    // Registry says standard/768 and config is standard/768 -> no embedding gap...
    expect(
      describeEmbeddingGap(
        { modelTier: "standard", vectorDim: 768 },
        { modelTier: "standard", vectorDim: 768 },
      ),
    ).toBeNull();
    // ...yet the physical table is still stranded at 384d -> schema gap fires.
    expect(describeSchemaDimGap(384, 768)).not.toBeNull();
  });

  it("treats a same-dim model swap as registry drift, not physical schema drift", () => {
    const embeddingGap = describeEmbeddingGap(
      { modelTier: "model-a", vectorDim: 768 },
      { modelTier: "model-b", vectorDim: 768 },
    );
    expect(embeddingGap).not.toBeNull();
    expect(embeddingGap?.dimChanged).toBe(false);
    // Same width on disk and in config -> no physical schema gap.
    expect(describeSchemaDimGap(768, 768)).toBeNull();
  });
});
