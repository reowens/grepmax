import { describe, expect, it, vi } from "vitest";
import { ColbertModel } from "../src/lib/workers/embeddings/colbert";
import { GraniteModel } from "../src/lib/workers/embeddings/granite";
import {
  cpuSessionOptions,
  ONNX_THREADS_ENV,
  onnxThreads,
  onnxThreadsFor,
} from "../src/lib/workers/embeddings/onnx-options";

describe("onnxThreadsFor", () => {
  it("keeps admitted files times threads within 1.5x the effective CPUs", () => {
    expect(onnxThreadsFor(4, 3)).toBe(2);
    expect(onnxThreadsFor(2, 1)).toBe(2);
    expect(onnxThreadsFor(3, 2)).toBe(2);
    expect(onnxThreadsFor(8, 7)).toBe(1);
  });

  it("never goes below 1 or above 4", () => {
    expect(onnxThreadsFor(1, 1)).toBe(1);
    expect(onnxThreadsFor(1, 4)).toBe(1);
    expect(onnxThreadsFor(24, 3)).toBe(4);
    expect(onnxThreadsFor(0.5, 0)).toBe(1);
  });
});

describe("cpuSessionOptions", () => {
  it("defaults to 1 thread when the pool sets none", () => {
    expect(onnxThreads({})).toBe(1);
    expect(onnxThreads({ [ONNX_THREADS_ENV]: "junk" })).toBe(1);
    expect(cpuSessionOptions({}).intraOpNumThreads).toBe(1);
  });

  it("uses the pool's thread count, capped at 4, with spinning off", () => {
    const options = cpuSessionOptions({ [ONNX_THREADS_ENV]: "2" });
    expect(options.intraOpNumThreads).toBe(2);
    expect(options.interOpNumThreads).toBe(1);
    expect(options.extra).toEqual({
      session: { intra_op: { allow_spinning: "0" } },
    });
    expect(onnxThreads({ [ONNX_THREADS_ENV]: "16" })).toBe(4);
  });
});

describe("CPU inference batching", () => {
  const fakeSession = (dim: number) => ({
    outputNames: ["out"],
    run: vi.fn(async (feeds: Record<string, { dims: number[] }>) => {
      const [batch, seq] = feeds.input_ids.dims;
      const data = new Float32Array(batch * seq * dim).fill(0.5);
      return {
        out: { data, dims: [batch, seq, dim] },
        last_hidden_state: { data, dims: [batch, seq, dim] },
      };
    }),
  });

  it("Granite runs 1 chunk per session call", async () => {
    const model = new GraniteModel(4) as any;
    const session = fakeSession(4);
    model.session = session;
    model.tokenizer = async (texts: string[]) => {
      const seq = Math.max(...texts.map((t) => t.length));
      return {
        input_ids: { data: new BigInt64Array(texts.length * seq), dims: [texts.length, seq] },
        attention_mask: { data: new BigInt64Array(texts.length * seq).fill(BigInt(1)), dims: [texts.length, seq] },
      };
    };
    const vectors = await model.runBatch(["ab", "abcd", "a"]);
    expect(vectors).toHaveLength(3);
    expect(session.run).toHaveBeenCalledTimes(3);
    expect(session.run.mock.calls.map((c: any) => c[0].input_ids.dims)).toEqual([
      [1, 2],
      [1, 4],
      [1, 1],
    ]);
  });

  it("ColBERT keeps the caller's batch whole, since its int8 scales span the batch", async () => {
    const model = new ColbertModel() as any;
    const session = fakeSession(2);
    model.session = session;
    model.tokenizer = {
      encodeDoc: async (t: string) => ({
        input_ids: Array.from(t, () => BigInt(7)),
        attention_mask: Array.from(t, () => BigInt(1)),
      }),
    };
    const dense = [new Float32Array([1]), new Float32Array([2])];
    const results = await model.runBatch(["abc", "a"], dense, 1);
    expect(session.run).toHaveBeenCalledTimes(1);
    expect(session.run.mock.calls[0][0].input_ids.dims).toEqual([2, 3]);
    expect(results.map((r: any) => r.dense)).toEqual(dense);
    expect(results.map((r: any) => r.colbert.length)).toEqual([6, 2]);
  });
});
