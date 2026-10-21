import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";
import { embeddingReuseKey } from "../src/lib/index/embedding-reuse";

const h = vi.hoisted(() => ({
  embed: vi.fn(),
  granite: vi.fn(),
  docs: vi.fn(),
  query: vi.fn(),
}));
vi.mock("../src/lib/workers/embeddings/gemma2", async (original) => ({
  ...(await original<typeof import("../src/lib/workers/embeddings/gemma2")>()),
  assertGemma2Profile: vi.fn(), // Profile admission has platform-independent contract cases.
}));
vi.mock("../src/lib/workers/embeddings/mlx-client", () => ({
  mlxEmbed: h.embed,
  mlxEmbedExisting: vi.fn(),
  isMlxExistingReady: () => false,
}));
vi.mock("../src/lib/workers/embeddings/granite", () => ({
  GraniteModel: class {
    runBatch = h.granite;
  },
}));
vi.mock("../src/lib/workers/embeddings/colbert", () => ({
  ColbertModel: class {
    isReady() {
      return true;
    }
    runBatch = h.docs;
    encodeQuery = h.query;
    async runSession() {
      return {
        embeddings: { data: new Float32Array(48).fill(0.1), dims: [1, 1, 48] },
      };
    }
    getOutputName() {
      return "embeddings";
    }
  },
}));

import { WorkerOrchestrator } from "../src/lib/workers/orchestrator";

let temporary: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  h.embed.mockImplementation(async (texts: string[]) =>
    texts.map(() => new Float32Array(768)),
  );
  h.docs.mockImplementation(async (_texts: string[], vectors: Float32Array[]) =>
    vectors.map((dense) => ({ dense, colbert: new Int8Array(), scale: 1 })),
  );
  h.query.mockResolvedValue({
    input_ids: BigInt64Array.from([BigInt(1)]),
    attention_mask: BigInt64Array.from([BigInt(1)]),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  temporary = undefined;
});
it.each([
  ["Which README explains setup?", "task: question answering | query: "],
  ["Find test cases for expiry", "task: code retrieval | query: "],
])(
  "prefixes dense queries and leaves ColBERT text intact: %s",
  async (query, prefix) => {
    const o = new WorkerOrchestrator(
      resolveEmbeddingGeneration({ modelTier: "gemma2" }),
      "gpu",
    );
    await o.encodeQuery(query);
    expect(h.embed).toHaveBeenCalledWith(
      [prefix + query],
      expect.objectContaining({ expectedDim: 768 }),
    );
    expect(h.query).toHaveBeenCalledWith(query);
    expect(h.granite).not.toHaveBeenCalled();
  },
);
it("fails closed when Gemma disappears, without loading Granite", async () => {
  const o = new WorkerOrchestrator(
    resolveEmbeddingGeneration({ modelTier: "gemma2" }),
    "gpu",
  );
  h.embed.mockResolvedValue(null);
  await expect(o.encodeQuery("handler")).rejects.toThrow(
    /fallback is disabled/,
  );
  await expect((o as any).computeHybrid(["handler"])).rejects.toThrow(
    /fallback is disabled/,
  );
  expect(h.granite).not.toHaveBeenCalled();
});
it("embeds each file title and declines content-only reuse while preserving stored and ColBERT content", async () => {
  temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "gmax-gemma-worker-")),
  );
  const file = path.join(temporary, "handler.ts"),
    body = "export function handler() { return 1; }";
  fs.writeFileSync(file, body);
  const o = new WorkerOrchestrator(
    resolveEmbeddingGeneration({ modelTier: "gemma2" }),
    "gpu",
  );
  vi.spyOn(o as any, "chunkFile").mockResolvedValue([{}]);
  vi.spyOn((o as any).skeletonizer, "skeletonizeFile").mockResolvedValue({});
  vi.spyOn(o as any, "toPreparedChunks").mockReturnValue([
    {
      id: "fixture",
      path: file,
      hash: "fixture",
      content: body,
      display_text: body,
      start_line: 0,
      end_line: 1,
    },
  ]);
  const result = await o.processFile({
    path: file,
    projectRoot: temporary,
    reusableKeys: [embeddingReuseKey(body)],
  });
  expect(h.embed).toHaveBeenCalledWith(
    [`title: ${path.basename(temporary)}/handler.ts | text: ${body}`],
    expect.anything(),
  );
  expect(h.docs).toHaveBeenCalledWith([body], expect.anything(), 768);
  expect(result.vectors[0].content).toBe(body);
  expect(result.reused ?? []).toHaveLength(0);
});
