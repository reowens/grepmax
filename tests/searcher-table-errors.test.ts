import { describe, expect, it, vi } from "vitest";
import { Searcher } from "../src/lib/search/searcher";
import type { VectorDB } from "../src/lib/store/vector-db";

describe("Searcher table failures", () => {
  it.each([
    "permission denied",
    "schema mismatch",
    "connection closed",
    "corrupt table",
  ])("propagates %s instead of returning no matches", async (message) => {
    const db = {
      ensureTable: vi.fn(async () => {
        throw new Error(message);
      }),
    } as unknown as VectorDB;

    await expect(new Searcher(db).search("authentication", 5)).rejects.toThrow(
      message,
    );
  });
});
