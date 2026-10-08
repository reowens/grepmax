import { expect, it, vi } from "vitest";
import { GraniteModel } from "../src/lib/workers/embeddings/granite";

it("restricted Granite encoding refuses cold sessions without load/tokenizer creation", async () => {
  const model = new GraniteModel(384);
  const load = vi.spyOn(model, "load");
  await expect(model.runBatch(["PRIVATE_QUERY"], true)).rejects.toThrow(
    "embedding_unavailable",
  );
  expect(load).not.toHaveBeenCalled();
});
it("restricted Granite encoding uses only injected warm sessions", async () => {
  const model = new GraniteModel(2),
    load = vi.spyOn(model, "load"),
    run = vi.fn(async () => ({
      last_hidden_state: { data: new Float32Array([1, 0]), dims: [1, 1, 2] },
    }));
  (model as any).session = { run, outputNames: ["last_hidden_state"] };
  (model as any).tokenizer = vi.fn(async () => ({
    input_ids: { data: new BigInt64Array([BigInt(1)]), dims: [1, 1] },
    attention_mask: { data: new BigInt64Array([BigInt(1)]) },
  }));
  expect(await model.runBatch(["query"], true)).toHaveLength(1);
  expect(load).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledOnce();
});
