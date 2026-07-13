import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateMlxEmbeddingResponse } from "../src/lib/workers/embeddings/mlx-client";

describe("MLX embedding response validation", () => {
  const valid = {
    model: "models/embed-v1",
    dim: 2,
    vectors: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
  };

  it("requires one finite vector per input text", () => {
    expect(validateMlxEmbeddingResponse(valid, 2, valid.model, 2)).toBe(true);
    expect(
      validateMlxEmbeddingResponse(
        { ...valid, vectors: valid.vectors.slice(0, 1) },
        2,
        valid.model,
        2,
      ),
    ).toBe(false);
    expect(
      validateMlxEmbeddingResponse(
        {
          ...valid,
          vectors: [
            [0.1, Number.NaN],
            [0.3, 0.4],
          ],
        },
        2,
        valid.model,
        2,
      ),
    ).toBe(false);
    expect(
      validateMlxEmbeddingResponse(
        {
          ...valid,
          vectors: [
            [0.1, Number.POSITIVE_INFINITY],
            [0.3, 0.4],
          ],
        },
        2,
        valid.model,
        2,
      ),
    ).toBe(false);
    expect(
      validateMlxEmbeddingResponse(
        {
          ...valid,
          vectors: [
            [0.1, 1e300],
            [0.3, 0.4],
          ],
        },
        2,
        valid.model,
        2,
      ),
    ).toBe(false);
  });

  it("binds the response to the expected model", () => {
    expect(
      validateMlxEmbeddingResponse(valid, 2, "models/replacement", 2),
    ).toBe(false);
  });
});

describe("MLX server batch contract", () => {
  it("rejects oversized batches instead of slicing them", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "mlx-embed-server", "server.py"),
      "utf8",
    );

    expect(source).toContain("if len(request.texts) > MAX_BATCH:");
    expect(source).toContain("status_code=413");
    expect(source).not.toContain("request.texts[:MAX_BATCH]");
  });
});
