import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectBatchProcessor } from "../src/lib/index/batch-processor";
import { embeddingReuseKey } from "../src/lib/index/embedding-reuse";
import { keepStoredRows, keptRowKey } from "../src/lib/index/kept-rows";
import type { VectorRecord } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";
import { computeContentHash } from "../src/lib/utils/file-utils";
import { getWorkerPool } from "../src/lib/workers/pool";

const DIM = 384;

// A worker stand-in: one chunk per blank-line-separated block, with the
// neighbour context and symbol columns the real row preparation fills.
function fakeWorker(input: { path: string; reusableKeys?: string[] }) {
  const buffer = fs.readFileSync(input.path);
  const stat = fs.statSync(input.path);
  const lines = buffer.toString("utf8").split("\n");
  const blocks: { text: string; start: number; end: number }[] = [];
  let start = -1;
  lines.forEach((line, i) => {
    if (line.trim() && start < 0) start = i;
    if ((!line.trim() || i === lines.length - 1) && start >= 0) {
      const end = line.trim() ? i : i - 1;
      blocks.push({
        text: lines.slice(start, end + 1).join("\n"),
        start,
        end,
      });
      start = -1;
    }
  });
  const reusable = new Set(input.reusableKeys ?? []);
  const reused: { index: number; key: string }[] = [];
  const contents = blocks.map((b) => `// ${input.path}\n${b.text}`);
  const vectors = blocks.map((block, i): VectorRecord => {
    const key = embeddingReuseKey(contents[i]);
    const isReused = reusable.has(key);
    if (isReused) reused.push({ index: i, key });
    return {
      id: `${Math.random()}`,
      path: input.path,
      hash: computeContentHash(buffer, input.path),
      content: contents[i],
      display_text: contents[i],
      context_prev: contents[i - 1],
      context_next: contents[i + 1],
      start_line: block.start,
      end_line: block.end,
      chunk_index: i,
      is_anchor: false,
      chunk_type: "function",
      complexity: 0.3,
      is_exported: true,
      defined_symbols: [block.text.split(/\s/)[0]],
      referenced_symbols: ["shared"],
      role: "DEFINITION",
      vector: isReused ? new Float32Array() : new Float32Array(DIM).fill(0.5),
      colbert: isReused ? Buffer.alloc(0) : Buffer.from([1, 2, 3]),
      colbert_scale: 1,
    };
  });
  return {
    vectors,
    hash: computeContentHash(buffer, input.path),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    ...(reused.length ? { reused } : {}),
  };
}

describe("keepStoredRows", () => {
  const record = (id: string): VectorRecord => ({
    id,
    path: "/repo/a.ts",
    hash: "new",
    content: "same",
    start_line: 1,
    end_line: 2,
    vector: [],
    colbert: [],
    colbert_scale: 1,
  });

  it("matches one stored row per record, so extra copies are left to delete", () => {
    const key = keptRowKey(record("x"));
    const stored = ["s1", "s2", "s3"].map((id) => ({ id, key }));

    const write = keepStoredRows([record("n1"), record("n2")], [0, 1], stored);

    expect(write.records).toEqual([]);
    expect(write.keptIds).toHaveLength(2);
    expect(new Set(write.keptIds).size).toBe(2);
  });

  it("keeps nothing for a record whose embedding was not reused", () => {
    const stored = [{ id: "s1", key: keptRowKey(record("x")) }];

    const write = keepStoredRows([record("n1")], [], stored);

    expect(write).toEqual({ records: [record("n1")], keptIds: [] });
  });
});

describe("kept rows across a file edit", () => {
  let dir: string;
  let file: string;
  let db: VectorDB;
  let meta: Map<string, any>;
  let processor: ProjectBatchProcessor;
  const pool = getWorkerPool() as any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-kept-"));
    file = path.join(dir, "sample.ts");
    db = new VectorDB(path.join(dir, "store"), DIM);
    db.compactIfNeeded = vi.fn(async () => false);
    meta = new Map();
    pool.processFile.mockReset();
    pool.processFile.mockImplementation(async (input: any) =>
      fakeWorker(input),
    );
    pool.isHealthy = vi.fn(() => true);
    processor = new ProjectBatchProcessor({
      projectRoot: dir,
      vectorDb: db,
      metaCache: {
        get: (p: string) => meta.get(p),
        put: (p: string, e: unknown) => meta.set(p, e),
        delete: (p: string) => meta.delete(p),
      } as any,
    });
  });

  afterEach(async () => {
    await processor.close();
    await db.close();
    pool.processFile.mockReset();
    delete pool.isHealthy;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function pass(
    content: string | null,
    event: "change" | "unlink" = "change",
  ) {
    if (content !== null) fs.writeFileSync(file, content);
    const p = processor as any;
    p.retryAt.clear();
    processor.handleFileEvent(event, file);
    for (const work of p.pendingWork.values()) {
      if (work.save)
        work.save = {
          firstPendingAt: Date.now() - 10_000,
          lastEventAt: Date.now() - 2_000,
        };
    }
    await p.processBatch(new AbortController().signal);
  }

  async function rows() {
    const table = await db.ensureTable();
    const all = await table
      .query()
      .select(["id", "path", "content", "start_line", "end_line", "hash"])
      .toArray();
    return all
      .map((r: any) => ({
        id: String(r.id),
        text: String(r.content).split("\n").slice(1).join("\n"),
        start: r.start_line,
        end: r.end_line,
        hash: String(r.hash),
      }))
      .sort((a, b) => a.start - b.start);
  }

  it("keeps both rows of 2 identical chunks when the end of the file changes", async () => {
    await pass("alpha\n\nsame\n\nsame\n\nspacer\n\nomega 1\n");
    const before = await rows();
    expect(before.map((r) => r.text)).toEqual([
      "alpha",
      "same",
      "same",
      "spacer",
      "omega 1",
    ]);

    await pass("alpha\n\nsame\n\nsame\n\nspacer\n\nomega 2\n");
    const after = await rows();

    expect(after.map((r) => r.text)).toEqual([
      "alpha",
      "same",
      "same",
      "spacer",
      "omega 2",
    ]);
    expect(after.slice(0, 3).map((r) => r.id)).toEqual(
      before.slice(0, 3).map((r) => r.id),
    );
  });

  it("an edit at the end keeps the rows above it and writes only the rest", async () => {
    await pass("one\n\ntwo\n\nthree\n\nfour\n");
    const before = await rows();
    const insert = vi.spyOn(db, "insertBatch");

    await pass("one\n\ntwo\n\nthree\n\nfour changed\n");
    const after = await rows();

    expect(after.slice(0, 2).map((r) => r.id)).toEqual(
      before.slice(0, 2).map((r) => r.id),
    );
    // "three" is rewritten because its next neighbour's text changed.
    expect(after.slice(2).map((r) => r.id)).not.toContain(before[2].id);
    expect(insert.mock.calls.flat(1).flat()).toHaveLength(2);
    expect(after).toHaveLength(4);
  });

  it("a reprocess of unchanged chunks writes no rows", async () => {
    await pass("one\n\ntwo\n");
    const before = await rows();
    const entry = meta.get(file);
    meta.set(file, { ...entry, hash: "stale", size: entry.size + 1 });
    const insert = vi.spyOn(db, "insertBatch");

    await pass(null);

    expect(insert).not.toHaveBeenCalled();
    expect((await rows()).map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(meta.get(file).hash).toBe(before[0].hash);
  });

  it("a line added at the top rewrites the rows below with their new lines", async () => {
    await pass("one\n\ntwo\n\nthree\n");
    const before = await rows();

    await pass("// header\n\none\n\ntwo\n\nthree\n");
    const after = await rows();

    expect(after.map((r) => [r.text, r.start, r.end])).toEqual([
      ["// header", 0, 0],
      ["one", 2, 2],
      ["two", 4, 4],
      ["three", 6, 6],
    ]);
    const old = new Set(before.map((r) => r.id));
    expect(after.filter((r) => old.has(r.id))).toEqual([]);
  });

  it("clears the duplicates of an insert whose delete failed on the next pass", async () => {
    await pass("one\n\ntwo\n\nthree\n");
    const failOnce = vi
      .spyOn(db, "deletePathsExcludingIds")
      .mockRejectedValueOnce(new Error("crash between insert and delete"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await pass("one\n\ntwo\n\nthree changed\n");
    expect((await rows()).length).toBeGreaterThan(3);
    expect(failOnce).toHaveBeenCalledOnce();

    await pass(null);
    const after = await rows();
    expect(after.map((r) => r.text)).toEqual(["one", "two", "three changed"]);
    expect(new Set(after.map((r) => r.id)).size).toBe(3);
    errors.mockRestore();
  });

  it("deleting the file removes all its rows", async () => {
    await pass("one\n\ntwo\n");
    expect(await rows()).toHaveLength(2);
    fs.rmSync(file);

    await pass(null, "unlink");

    expect(await rows()).toEqual([]);
    expect(meta.has(file)).toBe(false);
  });
});
