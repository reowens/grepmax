import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectBatchProcessor } from "../src/lib/index/batch-processor";
import { getWorkerPool } from "../src/lib/workers/pool";

function makeWorkerResult(absPath: string) {
  const stats = fs.statSync(absPath);
  return {
    hash: "hash",
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    shouldDelete: false,
    vectors: [],
  };
}

describe("ProjectBatchProcessor", () => {
  let tmpDir: string;
  let filePath: string;
  let vectorDb: any;
  let metaCache: any;
  let pool: any;
  let processors: ProjectBatchProcessor[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-batch-"));
    filePath = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(filePath, "export const sample = 1;\n");

    const meta = new Map<string, unknown>();
    metaCache = {
      get: vi.fn((p: string) => meta.get(p)),
      put: vi.fn((p: string, entry: unknown) => meta.set(p, entry)),
      delete: vi.fn((p: string) => meta.delete(p)),
    };
    vectorDb = {
      diskPressure: "ok",
      insertBatch: vi.fn(async () => {}),
      deletePaths: vi.fn(async () => {}),
      deletePathsExcludingIds: vi.fn(async () => {}),
      compactIfNeeded: vi.fn(async () => {}),
    };

    pool = getWorkerPool() as any;
    pool.processFile.mockReset();
    pool.processFile.mockResolvedValue(makeWorkerResult(filePath));
    pool.isHealthy = vi.fn(() => true);
    processors = [];
  });

  afterEach(async () => {
    await Promise.allSettled(processors.map((processor) => processor.close()));
    pool.processFile.mockReset();
    delete pool.isHealthy;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProcessor(): ProjectBatchProcessor {
    const processor = new ProjectBatchProcessor({
      projectRoot: tmpDir,
      vectorDb,
      metaCache,
    });
    processors.push(processor);
    return processor;
  }

  it("close waits for the active batch to settle", async () => {
    let resolveWorker!: (result: ReturnType<typeof makeWorkerResult>) => void;
    pool.processFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWorker = resolve;
        }),
    );

    const processor = makeProcessor();
    processor.handleFileEvent("change", filePath);
    (processor as any).startBatch();

    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledTimes(1));

    let closed = false;
    const closePromise = processor.close().then(() => {
      closed = true;
    });
    await Promise.resolve();

    expect(closed).toBe(false);

    resolveWorker(makeWorkerResult(filePath));
    await closePromise;

    expect(closed).toBe(true);
  });

  it("requeues the in-flight file when a batch is aborted", async () => {
    pool.processFile.mockImplementationOnce(
      (_input: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const processor = makeProcessor();
    processor.handleFileEvent("change", filePath);
    (processor as any).startBatch();

    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledTimes(1));
    const activeBatch = (processor as any).activeBatch as Promise<void>;

    (processor as any).currentBatchAc.abort();
    await activeBatch;

    expect(processor.progress.pendingFiles).toBe(1);
  });
});
