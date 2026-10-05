import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CONFIG } from "../src/config";
import { Searcher } from "../src/lib/search/searcher";
import { VectorDB } from "../src/lib/store/vector-db";
import { getWorkerPool } from "../src/lib/workers/pool";

afterEach(() => vi.unstubAllEnvs());
it("retrieves expanded matches from a native temporary store without changing other requests", async () => {
  vi.stubEnv("GMAX_CONCENTRATION_THRESHOLD", "2");
  vi.stubEnv("GMAX_MAX_PER_FILE", "3");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-per-file-"));
  const db = new VectorDB(dir, CONFIG.VECTOR_DIM);
  const vector = Array(CONFIG.VECTOR_DIM).fill(0);
  vector[0] = 1;
  const pool = getWorkerPool();
  vi.mocked(pool.encodeQuery).mockResolvedValue({
    dense: vector,
    colbert: [],
    colbertDim: CONFIG.COLBERT_DIM,
  });
  try {
    const seed = (db as any).seedRow();
    await db.insertBatch(
      Array.from({ length: 12 }, (_, i) => ({
        ...seed,
        id: `per-file-${i}`,
        path: path.join(dir, "monolith.ts"),
        hash: "fixture",
        vector,
        start_line: i * 10,
        end_line: i * 10 + 3,
        content: `function handle${i}() { /* handles incoming fixture requests */ }`,
        display_text: `function handle${i}() { /* handles incoming fixture requests */ }`,
        defined_symbols: [`handle${i}`],
        chunk_type: "function",
        role: "IMPLEMENTATION",
        is_anchor: false,
      })),
    );
    const searcher = new Searcher(db);
    const query = "handles incoming fixture requests";
    const ordinary = await searcher.search(
      query,
      10,
      { diagnostics: true },
      undefined,
      `${dir}/`,
    );
    const [expanded, small] = await Promise.all([
      searcher.search(
        query,
        10,
        { maxPerFile: 6, diagnostics: true },
        undefined,
        `${dir}/`,
      ),
      searcher.search(
        query,
        10,
        { maxPerFile: 1, diagnostics: true },
        undefined,
        `${dir}/`,
      ),
    ]);
    const after = await searcher.search(
      query,
      10,
      { diagnostics: true },
      undefined,
      `${dir}/`,
    );
    expect([
      ordinary.data.length,
      expanded.data.length,
      small.data.length,
      after.data.length,
    ]).toEqual([3, 6, 1, 3]);
    expect(after.data).toEqual(ordinary.data);
    expect(expanded.diagnostics?.settings.maxPerFile).toBe(6);
    expect(expanded.data.slice(0, 3)).toEqual(ordinary.data);
    expect(
      expanded.data.every((row) => row.text?.includes("fixture requests")),
    ).toBe(true);
    expect(process.env.GMAX_MAX_PER_FILE).toBe("3");
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
