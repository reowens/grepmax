import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../src/config";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";
import { embeddingReuseKey } from "../src/lib/index/embedding-reuse";
import type { VectorRecord } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";

const mocks = vi.hoisted(() => ({ mlxEmbed: vi.fn() }));

vi.mock("../src/lib/workers/embeddings/mlx-client", () => ({
  mlxEmbed: mocks.mlxEmbed,
}));

vi.mock("../src/lib/workers/embeddings/colbert", () => ({
  ColbertModel: class {
    isReady() {
      return true;
    }

    async runBatch(_texts: string[], dense: Float32Array[]) {
      return dense.map((vector) => ({
        dense: vector,
        colbert: new Int8Array([1, 2, 3]),
        scale: 1,
      }));
    }
  },
}));

import { WorkerOrchestrator } from "../src/lib/workers/orchestrator";

const DIM = 384;

function record(filePath: string, content: string, seed: number): VectorRecord {
  return {
    id: `${path.basename(filePath)}-${seed}`,
    path: filePath,
    hash: "h",
    content,
    start_line: seed,
    end_line: seed + 1,
    vector: new Float32Array(DIM).fill(seed / 10),
    colbert: Buffer.from([seed, seed + 1, 255]),
    colbert_scale: seed / 4,
    pooled_colbert_48d: new Float32Array(CONFIG.COLBERT_DIM).fill(seed),
    doc_token_ids: [seed, seed + 100],
  };
}

describe("VectorDB.getReusableEmbeddings", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-reuse-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns exactly the stored embeddings of one file, keyed by content", async () => {
    const db = new VectorDB(dir, DIM);
    const target = "/repo/docs/it's a plan.md";
    await db.insertBatch([
      record(target, "alpha", 1),
      record(target, "beta", 2),
      record("/repo/docs/other.md", "alpha", 3),
    ]);

    const reusable = await db.getReusableEmbeddings(target);

    expect([...reusable.keys()].sort()).toEqual(
      [embeddingReuseKey("alpha"), embeddingReuseKey("beta")].sort(),
    );
    const beta = reusable.get(embeddingReuseKey("beta"))!;
    expect(beta.vector).toBeInstanceOf(Float32Array);
    expect(beta.vector).toEqual(new Float32Array(DIM).fill(0.2));
    expect([...beta.colbert]).toEqual([2, 3, 255]);
    expect(beta.colbert_scale).toBe(0.5);
    expect(beta.pooled_colbert_48d).toEqual(
      new Float32Array(CONFIG.COLBERT_DIM).fill(2),
    );
    expect([...beta.doc_token_ids!]).toEqual([2, 102]);

    // A reused embedding must survive being written back unchanged.
    await db.insertBatch([
      { ...record(target, "beta", 2), id: "copy", ...beta },
    ]);
    const again = await db.getReusableEmbeddings(target);
    expect(again.get(embeddingReuseKey("beta"))!.vector).toEqual(beta.vector);
    await db.close();
  });

  it("returns nothing for an unindexed file", async () => {
    const db = new VectorDB(dir, DIM);
    await db.ensureTable();
    expect((await db.getReusableEmbeddings("/repo/none.ts")).size).toBe(0);
    await db.close();
  });
});

describe("WorkerOrchestrator.processFile with reusable keys", () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-reuse-orch-"));
    file = path.join(root, "plan.md");
    const sections = Array.from(
      { length: 6 },
      (_, i) =>
        `## Section ${i}\n\n${`Paragraph ${i} explains one decision in detail. `.repeat(20)}\n`,
    );
    fs.writeFileSync(file, `# Plan\n\n${sections.join("\n")}`);
    mocks.mlxEmbed.mockReset();
    mocks.mlxEmbed.mockImplementation(async (texts: string[]) =>
      texts.map(() => new Float32Array(DIM).fill(1)),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("embeds only the chunks whose key was not offered", async () => {
    const orchestrator = new WorkerOrchestrator(
      resolveEmbeddingGeneration({ modelTier: "small" }),
      "gpu",
    );
    const full = await orchestrator.processFile({
      path: file,
      projectRoot: root,
    });
    expect(full.vectors.length).toBeGreaterThan(2);
    expect(full.reused).toBeUndefined();

    const offered = full.vectors
      .slice(1)
      .map((v) => embeddingReuseKey(v.content));
    mocks.mlxEmbed.mockClear();
    const partial = await orchestrator.processFile({
      path: file,
      projectRoot: root,
      reusableKeys: offered,
    });

    const embeddedTexts = mocks.mlxEmbed.mock.calls.flatMap(
      ([texts]) => texts as string[],
    );
    expect(embeddedTexts).toEqual([full.vectors[0].content]);
    expect(partial.reused?.map((r) => r.index)).toEqual(
      full.vectors.slice(1).map((_, i) => i + 1),
    );
    expect(partial.vectors[0].vector).toHaveLength(DIM);
    for (const { index, key } of partial.reused!) {
      expect(partial.vectors[index].vector).toHaveLength(0);
      expect(key).toBe(embeddingReuseKey(partial.vectors[index].content));
    }
  });

  it("does not call the embedder when every chunk is reused", async () => {
    const orchestrator = new WorkerOrchestrator(
      resolveEmbeddingGeneration({ modelTier: "small" }),
      "gpu",
    );
    const full = await orchestrator.processFile({
      path: file,
      projectRoot: root,
    });
    mocks.mlxEmbed.mockClear();

    const partial = await orchestrator.processFile({
      path: file,
      projectRoot: root,
      reusableKeys: full.vectors.map((v) => embeddingReuseKey(v.content)),
    });

    expect(mocks.mlxEmbed).not.toHaveBeenCalled();
    expect(partial.reused).toHaveLength(full.vectors.length);
  });
});
