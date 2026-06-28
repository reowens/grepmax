import { describe, expect, it, vi } from "vitest";
import type { VectorRecord } from "../src/lib/store/types";

// The global tests/setup.ts replaces the pool module with a stub that omits
// embeddingEnv; use the real module here.
vi.unmock("../src/lib/workers/pool");

// Override only readGlobalConfig so the active tier is `standard` (768d). Keep
// getModelIdsForTier real so the tier -> env mapping is exercised end to end,
// and so VectorDB's config-derived default dim is the genuine standard width.
vi.mock("../src/lib/index/index-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/index/index-config")>();
  return {
    ...actual,
    readGlobalConfig: vi.fn(() => ({
      modelTier: "standard",
      vectorDim: 768,
      embedMode: "cpu" as const,
    })),
  };
});

import { VectorDB } from "../src/lib/store/vector-db";
import { embeddingEnv } from "../src/lib/workers/pool";

function makeRecord(vector: number[]): VectorRecord {
  return {
    id: "id-1",
    path: "/repo/file.ts",
    hash: "abc",
    content: "x",
    start_line: 1,
    end_line: 1,
    vector,
    colbert: [],
    colbert_scale: 1,
  };
}

// Bypass disk + LanceDB so insertBatch reaches the dimension check without a
// real table. Returns the fake table to assert the positive path wrote to it.
function stubStore(db: VectorDB) {
  const table = {
    add: vi.fn(async () => {}),
    schema: vi.fn(async () => ({ fields: [] as { name: string }[] })),
  };
  vi.spyOn(
    db as unknown as { ensureDiskOk: () => void },
    "ensureDiskOk",
  ).mockImplementation(() => {});
  vi.spyOn(
    db as unknown as { ensureTable: () => Promise<unknown> },
    "ensureTable",
  ).mockResolvedValue(table);
  return table;
}

describe("embeddingEnv", () => {
  it("maps the active model tier to worker env vars", () => {
    const env = embeddingEnv();
    expect(env.GMAX_VECTOR_DIM).toBe("768");
    expect(env.GMAX_EMBED_ONNX_MODEL).toBe(
      "onnx-community/granite-embedding-english-r2-ONNX",
    );
  });
});

describe("VectorDB dimension handling", () => {
  it("throws on a vector whose width != the configured dim", async () => {
    const db = new VectorDB("/tmp/gmax-dim-test", 768);
    stubStore(db);
    await expect(
      db.insertBatch([makeRecord(new Array(384).fill(0.1))]),
    ).rejects.toThrow(/dimension mismatch/i);
  });

  it("defaults its dim from the global config (standard -> 768)", async () => {
    // No explicit dim: the constructor must fall back to readGlobalConfig().vectorDim.
    const db = new VectorDB("/tmp/gmax-dim-test");
    stubStore(db);
    await expect(
      db.insertBatch([makeRecord(new Array(384).fill(0.1))]),
    ).rejects.toThrow(/expected 768d/);
  });

  it("accepts a vector of exactly the configured width", async () => {
    const db = new VectorDB("/tmp/gmax-dim-test", 768);
    const table = stubStore(db);
    await db.insertBatch([makeRecord(new Array(768).fill(0.1))]);
    expect(table.add).toHaveBeenCalledOnce();
  });
});
