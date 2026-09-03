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
  let meta: Map<string, unknown>;
  let processors: ProjectBatchProcessor[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-batch-"));
    filePath = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(filePath, "export const sample = 1;\n");

    meta = new Map<string, unknown>();
    metaCache = {
      get: vi.fn((p: string) => meta.get(p)),
      put: vi.fn((p: string, entry: unknown) => meta.set(p, entry)),
      delete: vi.fn((p: string) => meta.delete(p)),
    };
    vectorDb = {
      diskPressure: "ok",
      checkDiskPressure: vi.fn(() => vectorDb.diskPressure),
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
    vi.useRealTimers();
    await Promise.allSettled(processors.map((processor) => processor.close()));
    pool.processFile.mockReset();
    delete pool.isHealthy;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProcessor(
    extra: Partial<ConstructorParameters<typeof ProjectBatchProcessor>[0]> = {},
  ): ProjectBatchProcessor {
    const processor = new ProjectBatchProcessor({
      projectRoot: tmpDir,
      vectorDb,
      metaCache,
      ...extra,
    });
    processors.push(processor);
    return processor;
  }

  function makeFiles(count: number): string[] {
    const files = [filePath];
    for (let i = 1; i < count; i++) {
      const candidate = path.join(tmpDir, `sample-${i}.ts`);
      fs.writeFileSync(candidate, `export const sample${i} = ${i};\n`);
      files.push(candidate);
    }
    return files;
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

  it("runs up to the configured concurrency and dispatches the next file on settlement", async () => {
    const files = makeFiles(4);
    let active = 0;
    let maxActive = 0;
    const pending: Array<{
      path: string;
      resolve: (result: ReturnType<typeof makeWorkerResult>) => void;
    }> = [];
    pool.processFile.mockImplementation(
      (input: { path: string }) =>
        new Promise((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          pending.push({
            path: input.path,
            resolve: (result) => {
              active--;
              resolve(result);
            },
          });
        }),
    );
    const processor = makeProcessor({ concurrency: 3 });
    for (const file of files) processor.handleFileEvent("change", file);

    (processor as any).startBatch();
    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledTimes(3));
    expect(maxActive).toBe(3);

    pending[0].resolve(makeWorkerResult(pending[0].path));
    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledTimes(4));
    for (const task of pending.slice(1)) {
      task.resolve(makeWorkerResult(task.path));
    }
    await (processor as any).activeBatch;

    expect(maxActive).toBe(3);
    expect(processor.progress.pendingFiles).toBe(0);
  });

  it("is strictly sequential when concurrency is one", async () => {
    const files = makeFiles(3);
    const pending: Array<{
      path: string;
      resolve: (result: ReturnType<typeof makeWorkerResult>) => void;
    }> = [];
    pool.processFile.mockImplementation(
      (input: { path: string }) =>
        new Promise((resolve) => pending.push({ path: input.path, resolve })),
    );
    const processor = makeProcessor({ concurrency: 1 });
    for (const file of files) processor.handleFileEvent("change", file);

    (processor as any).startBatch();
    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledTimes(1));
    pending[0].resolve(makeWorkerResult(pending[0].path));
    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledTimes(2));
    pending[1].resolve(makeWorkerResult(pending[1].path));
    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledTimes(3));
    pending[2].resolve(makeWorkerResult(pending[2].path));
    await (processor as any).activeBatch;

    expect(processor.progress.pendingFiles).toBe(0);
  });

  it("waits for out-of-order workers before one insert-then-delete commit", async () => {
    const files = makeFiles(3);
    const pending = new Map<string, (result: any) => void>();
    pool.processFile.mockImplementation(
      (input: { path: string }) =>
        new Promise((resolve) => pending.set(input.path, resolve)),
    );
    const processor = makeProcessor({ concurrency: 3 });
    for (const file of files) processor.handleFileEvent("change", file);

    (processor as any).startBatch();
    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledTimes(3));
    for (const file of [files[2], files[0], files[1]]) {
      pending.get(file)?.({
        ...makeWorkerResult(file),
        vectors: [{ id: path.basename(file), path: file }],
      });
    }
    await (processor as any).activeBatch;

    expect(vectorDb.insertBatch).toHaveBeenCalledOnce();
    expect(vectorDb.insertBatch.mock.calls[0][0]).toHaveLength(3);
    expect(vectorDb.deletePathsExcludingIds).toHaveBeenCalledOnce();
    expect(vectorDb.insertBatch.mock.invocationCallOrder[0]).toBeLessThan(
      vectorDb.deletePathsExcludingIds.mock.invocationCallOrder[0],
    );
  });

  it("requeues the whole batch without retry cost when concurrent work is aborted", async () => {
    const files = makeFiles(5);
    pool.processFile.mockImplementation(
      (_input: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const processor = makeProcessor({ concurrency: 3 });
    for (const file of files) processor.handleFileEvent("change", file);

    (processor as any).startBatch();
    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledTimes(3));
    (processor as any).currentBatchAc.abort();
    await (processor as any).activeBatch;

    expect(processor.progress.pendingFiles).toBe(5);
    expect((processor as any).retryCount.size).toBe(0);
    expect(vectorDb.insertBatch).not.toHaveBeenCalled();
  });

  it("stops dispatching new work when the worker pool becomes unhealthy", async () => {
    const files = makeFiles(5);
    pool.processFile.mockRejectedValue(new Error("worker exited"));
    pool.isHealthy.mockReturnValue(false);
    const processor = makeProcessor({ concurrency: 2 });
    for (const file of files) processor.handleFileEvent("change", file);

    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(pool.processFile.mock.calls.length).toBeLessThanOrEqual(3);
    expect(processor.progress.pendingFiles).toBe(5);
    expect((processor as any).retryCount.size).toBe(0);
  });

  it("reports settled progress monotonically under concurrent completion", async () => {
    const files = makeFiles(12);
    pool.processFile.mockImplementation(async (input: { path: string }) =>
      makeWorkerResult(input.path),
    );
    const writeSpy = vi.spyOn(process.stderr, "write");
    const processor = makeProcessor({ concurrency: 3 });
    for (const file of files) processor.handleFileEvent("change", file);

    (processor as any).startBatch();
    await (processor as any).activeBatch;

    const progress = writeSpy.mock.calls
      .map(([message]) => String(message).match(/Progress: (\d+)\/12/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => Number(match[1]));
    writeSpy.mockRestore();

    expect(progress).toEqual([10, 12]);
  });

  it("removes a cached file after deterministic policy exclusion", async () => {
    const sensitive = path.join(tmpDir, "secrets.ts");
    fs.writeFileSync(sensitive, "export const token = 'secret';\n");
    meta.set(sensitive, { hash: "old", mtimeMs: 1, size: 1 });
    const processor = makeProcessor();

    processor.handleFileEvent("change", sensitive);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(pool.processFile).not.toHaveBeenCalled();
    expect(vectorDb.deletePaths).toHaveBeenCalledWith([sensitive]);
    expect(metaCache.delete).toHaveBeenCalledWith(sensitive);
  });

  it("bypasses the hash fast path for a forced vector repair", async () => {
    const stats = fs.statSync(filePath);
    meta.set(filePath, {
      hash: "hash",
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      hashVersion: 1,
      hasVectors: true,
    });
    pool.processFile.mockResolvedValue({
      ...makeWorkerResult(filePath),
      vectors: [{ id: "replacement", path: filePath }],
    });
    const processor = makeProcessor();

    processor.handleFileEvent("change", filePath, { forceReprocess: true });
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(pool.processFile).toHaveBeenCalledOnce();
    expect(vectorDb.insertBatch).toHaveBeenCalledOnce();
    expect(vectorDb.deletePathsExcludingIds).toHaveBeenCalledWith(
      [filePath],
      ["replacement"],
    );
  });

  it("preserves a newer forced repair event while an older one is in flight", async () => {
    const stats = fs.statSync(filePath);
    meta.set(filePath, {
      hash: "hash",
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      hashVersion: 1,
      hasVectors: true,
    });
    const result = {
      ...makeWorkerResult(filePath),
      vectors: [{ id: "replacement", path: filePath }],
    };
    let resolveFirst!: (value: typeof result) => void;
    pool.processFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    pool.processFile.mockResolvedValue(result);
    const processor = makeProcessor();

    processor.handleFileEvent("change", filePath, { forceReprocess: true });
    (processor as any).startBatch();
    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledOnce());

    processor.handleFileEvent("change", filePath, { forceReprocess: true });
    resolveFirst(result);
    await (processor as any).activeBatch;
    expect(processor.progress.pendingFiles).toBe(1);

    (processor as any).startBatch();
    await (processor as any).activeBatch;
    expect(pool.processFile).toHaveBeenCalledTimes(2);
  });

  it("deletes a vector-only orphan with a retired extension", async () => {
    const orphan = path.join(tmpDir, "removed.retired-extension");
    const processor = makeProcessor();

    processor.handleFileEvent("unlink", orphan, { forceDelete: true });
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(vectorDb.deletePaths).toHaveBeenCalledWith([orphan]);
    expect(metaCache.delete).toHaveBeenCalledWith(orphan);
  });

  it("deletes a stale policy-file row without starting another reconciliation", async () => {
    const policyFile = path.join(tmpDir, ".gitignore");
    const onPolicyChange = vi.fn();
    const processor = makeProcessor({ onPolicyChange });

    processor.handleFileEvent("unlink", policyFile, { forceDelete: true });
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(onPolicyChange).not.toHaveBeenCalled();
    expect(vectorDb.deletePaths).toHaveBeenCalledWith([policyFile]);
    expect(metaCache.delete).toHaveBeenCalledWith(policyFile);
  });

  it("drops never-indexed events under a policy-ignored directory before queueing", async () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".runlist/\n");
    const processor = makeProcessor();
    await processor.filePolicy.classifyFile(filePath); // loads the root scope
    const lockFile = path.join(tmpDir, ".runlist/locks/a/owner.json");

    processor.handleFileEvent("change", lockFile);
    processor.handleFileEvent("unlink", lockFile);
    expect(processor.progress.pendingFiles).toBe(0);

    // A path the index already knows about must still flow through, so a
    // policy change can retire its vectors.
    meta.set(lockFile, { hash: "h", mtimeMs: 1, size: 1 });
    processor.handleFileEvent("unlink", lockFile);
    expect(processor.progress.pendingFiles).toBe(1);
  });

  it("rejects outside-root events before queueing", () => {
    const processor = makeProcessor();
    processor.handleFileEvent(
      "unlink",
      path.join(path.dirname(tmpDir), "x.ts"),
    );
    expect(processor.progress.pendingFiles).toBe(0);
  });

  it("invalidates policy files and requests reconciliation", () => {
    const onPolicyChange = vi.fn();
    const processor = makeProcessor({ onPolicyChange });
    processor.handleFileEvent("change", path.join(tmpDir, ".gitignore"));

    expect(onPolicyChange).toHaveBeenCalledOnce();
    expect(processor.progress.pendingFiles).toBe(0);
  });

  it("preserves cached state on policy errors", async () => {
    const errorPolicy = {
      isLexicallyContained: () => true,
      isPolicyFile: () => false,
      classifyFile: async () => ({
        status: "error",
        error: new Error("EACCES"),
        protectedPath: filePath,
      }),
    } as any;
    meta.set(filePath, { hash: "old", mtimeMs: 1, size: 1 });
    const processor = makeProcessor({ filePolicy: errorPolicy });

    processor.handleFileEvent("change", filePath);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(vectorDb.deletePaths).not.toHaveBeenCalled();
    expect(metaCache.delete).not.toHaveBeenCalled();
    expect(pool.processFile).not.toHaveBeenCalled();
    expect(processor.progress.pendingFiles).toBe(1);
  });

  it("retries a transient policy error without another filesystem event", async () => {
    vi.useFakeTimers();
    const realPolicy = makeProcessor().filePolicy;
    await processors.pop()?.close();
    let attempts = 0;
    const transientPolicy = {
      isLexicallyContained: (candidate: string) =>
        realPolicy.isLexicallyContained(candidate),
      isPolicyFile: (candidate: string) => realPolicy.isPolicyFile(candidate),
      classifyFile: async (candidate: string) => {
        attempts++;
        if (attempts === 1) {
          return {
            status: "error",
            error: new Error("EIO"),
            protectedPath: candidate,
          };
        }
        return realPolicy.classifyFile(candidate);
      },
    } as any;
    const processor = makeProcessor({ filePolicy: transientPolicy });

    processor.handleFileEvent("change", filePath);
    (processor as any).startBatch();
    await (processor as any).activeBatch;
    expect(processor.progress.pendingFiles).toBe(1);
    expect((processor as any).retryCount.get(filePath)).toBe(1);
    expect((processor as any).retryAt.get(filePath) - Date.now()).toBe(4_000);

    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledOnce());

    expect(pool.processFile).toHaveBeenCalledOnce();
    expect(processor.progress.pendingFiles).toBe(0);
    vi.useRealTimers();
  });

  it("preserves a newer event over an older failed event", async () => {
    let rejectWorker!: (error: Error) => void;
    pool.processFile.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWorker = reject;
        }),
    );
    const processor = makeProcessor();

    processor.handleFileEvent("change", filePath);
    (processor as any).startBatch();
    await vi.waitFor(() => expect(pool.processFile).toHaveBeenCalledOnce());
    processor.handleFileEvent("unlink", filePath);
    rejectWorker(new Error("transient worker failure"));
    await (processor as any).activeBatch;

    expect((processor as any).pending.get(filePath)).toBe("unlink");
    expect((processor as any).retryCount.has(filePath)).toBe(false);
  });

  it("stops automatic retries at the per-path failure cap", async () => {
    const onTerminalFailure = vi.fn();
    const errorPolicy = {
      isLexicallyContained: () => true,
      isPolicyFile: () => false,
      classifyFile: async () => ({
        status: "error",
        error: new Error("EIO"),
        protectedPath: filePath,
      }),
    } as any;
    meta.set(filePath, { hash: "old", mtimeMs: 1, size: 1 });
    const processor = makeProcessor({
      filePolicy: errorPolicy,
      onTerminalFailure,
    });
    processor.handleFileEvent("change", filePath);
    (processor as any).retryCount.set(filePath, 4);

    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(processor.progress.pendingFiles).toBe(0);
    expect(processor.progress.failedFiles).toBe(1);
    expect((processor as any).retryCount.has(filePath)).toBe(false);
    expect(onTerminalFailure).toHaveBeenCalledWith(filePath);
    expect(vectorDb.deletePaths).not.toHaveBeenCalled();
    expect(metaCache.delete).not.toHaveBeenCalled();
  });

  it("does not reset retry budget for duplicate watcher events", () => {
    const processor = makeProcessor();
    (processor as any).retryCount.set(filePath, 2);
    (processor as any).retryAt.set(filePath, Date.now() + 30_000);

    processor.handleFileEvent("change", filePath);

    expect((processor as any).retryCount.get(filePath)).toBe(2);
    expect((processor as any).retryAt.has(filePath)).toBe(false);
  });

  it("does not resurrect a capped path after a batch-wide failure", async () => {
    const otherPath = path.join(tmpDir, "other.ts");
    fs.writeFileSync(otherPath, "export const other = 1;\n");
    const policy = {
      isLexicallyContained: () => true,
      isPolicyFile: () => false,
      classifyFile: async (candidate: string) => {
        if (candidate === filePath) {
          return {
            status: "error",
            error: new Error("EIO"),
            protectedPath: candidate,
          };
        }
        return { status: "indexable", stat: fs.statSync(candidate) };
      },
    } as any;
    pool.processFile.mockResolvedValueOnce({
      ...makeWorkerResult(otherPath),
      vectors: [{ id: "other", path: otherPath }],
    });
    vectorDb.insertBatch.mockRejectedValueOnce(new Error("database busy"));
    const processor = makeProcessor({ filePolicy: policy });
    processor.handleFileEvent("change", filePath);
    processor.handleFileEvent("change", otherPath);
    (processor as any).retryCount.set(filePath, 4);

    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect((processor as any).terminalFailures.has(filePath)).toBe(true);
    expect((processor as any).pending.has(filePath)).toBe(false);
    expect((processor as any).pending.get(otherPath)).toBe("change");
  });

  it("does not spend retry budget on store-wide corruption", async () => {
    const sensitive = path.join(tmpDir, "secrets.ts");
    fs.writeFileSync(sensitive, "export const token = 'secret';\n");
    meta.set(sensitive, { hash: "old", mtimeMs: 1, size: 1 });
    vectorDb.deletePaths.mockRejectedValueOnce(
      new Error("Not found: deadbeef.lance fragment"),
    );
    const processor = makeProcessor();

    processor.handleFileEvent("change", sensitive);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(processor.progress.pendingFiles).toBe(1);
    expect((processor as any).retryCount.has(sensitive)).toBe(false);
    expect(metaCache.delete).not.toHaveBeenCalled();
  });

  it("deletes an unlinked file under critical disk pressure", async () => {
    const stats = fs.statSync(filePath);
    meta.set(filePath, {
      hash: "old",
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    });
    fs.unlinkSync(filePath);
    vectorDb.diskPressure = "critical";
    const processor = makeProcessor();

    processor.handleFileEvent("unlink", filePath);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(pool.processFile).not.toHaveBeenCalled();
    expect(vectorDb.deletePaths).toHaveBeenCalledWith([filePath]);
    expect(metaCache.delete).toHaveBeenCalledWith(filePath);
    expect(processor.progress.pendingFiles).toBe(0);
  });

  it("preserves metadata when a critical-pressure delete fails with ENOSPC", async () => {
    const cached = { hash: "old", mtimeMs: 1, size: 1 };
    meta.set(filePath, cached);
    fs.unlinkSync(filePath);
    vectorDb.diskPressure = "critical";
    vectorDb.deletePaths.mockRejectedValueOnce(
      Object.assign(new Error("No space left on device"), { code: "ENOSPC" }),
    );
    const processor = makeProcessor();

    processor.handleFileEvent("unlink", filePath);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(meta.get(filePath)).toBe(cached);
    expect(metaCache.delete).not.toHaveBeenCalled();
    expect(processor.progress.pendingFiles).toBe(1);
    expect((processor as any).retryCount.has(filePath)).toBe(false);
  });

  it("deletes removals and defers indexable changes under critical pressure", async () => {
    const removed = path.join(tmpDir, "removed.ts");
    meta.set(removed, { hash: "old", mtimeMs: 1, size: 1 });
    vectorDb.diskPressure = "critical";
    const processor = makeProcessor();

    processor.handleFileEvent("unlink", removed);
    processor.handleFileEvent("change", filePath);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(pool.processFile).not.toHaveBeenCalled();
    expect(vectorDb.deletePaths).toHaveBeenCalledWith([removed]);
    expect(metaCache.delete).toHaveBeenCalledWith(removed);
    expect(processor.progress.pendingFiles).toBe(1);
    expect((processor as any).retryCount.has(filePath)).toBe(false);
  });

  it("deletes a newly excluded file under critical disk pressure", async () => {
    const sensitive = path.join(tmpDir, "secrets.ts");
    fs.writeFileSync(sensitive, "export const token = 'secret';\n");
    meta.set(sensitive, { hash: "old", mtimeMs: 1, size: 1 });
    vectorDb.diskPressure = "critical";
    const processor = makeProcessor();

    processor.handleFileEvent("change", sensitive);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(pool.processFile).not.toHaveBeenCalled();
    expect(vectorDb.deletePaths).toHaveBeenCalledWith([sensitive]);
    expect(metaCache.delete).toHaveBeenCalledWith(sensitive);
    expect(processor.progress.pendingFiles).toBe(0);
  });

  it("refreshes disk pressure before deciding whether to defer work", async () => {
    vectorDb.diskPressure = "critical";
    vectorDb.checkDiskPressure.mockImplementationOnce(() => {
      vectorDb.diskPressure = "ok";
      return "ok";
    });
    const processor = makeProcessor();

    processor.handleFileEvent("change", filePath);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(vectorDb.checkDiskPressure).toHaveBeenCalledOnce();
    expect(pool.processFile).toHaveBeenCalledOnce();
    expect(processor.progress.pendingFiles).toBe(0);
  });

  it("does not spend retry budget while disk pressure defers work", async () => {
    vectorDb.diskPressure = "critical";
    const processor = makeProcessor();

    processor.handleFileEvent("change", filePath);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(processor.progress.pendingFiles).toBe(1);
    expect((processor as any).retryCount.has(filePath)).toBe(false);
  });

  it("treats an unlink for a recreated file as a change", async () => {
    meta.set(filePath, { hash: "old", mtimeMs: 1, size: 1 });
    const processor = makeProcessor();

    processor.handleFileEvent("unlink", filePath);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(pool.processFile).toHaveBeenCalledOnce();
    expect(metaCache.put).toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({ hash: "hash" }),
    );
    expect(metaCache.delete).not.toHaveBeenCalled();
  });

  it("revalidates a pure delete immediately before database application", async () => {
    const realPolicy = makeProcessor().filePolicy;
    await processors.pop()?.close();
    let classifications = 0;
    const recreatedPolicy = {
      isLexicallyContained: (candidate: string) =>
        realPolicy.isLexicallyContained(candidate),
      isPolicyFile: () => false,
      classifyFile: async (candidate: string) => {
        classifications++;
        return classifications === 1
          ? { status: "missing" }
          : realPolicy.classifyFile(candidate);
      },
    } as any;
    meta.set(filePath, { hash: "old", mtimeMs: 1, size: 1 });
    const processor = makeProcessor({ filePolicy: recreatedPolicy });

    processor.handleFileEvent("unlink", filePath);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(vectorDb.deletePaths).not.toHaveBeenCalled();
    expect(metaCache.delete).not.toHaveBeenCalled();
    expect(processor.progress.pendingFiles).toBe(1);
  });

  it("normalizes canonical events into a symlinked project root", async () => {
    const alias = `${tmpDir}-alias`;
    fs.symlinkSync(tmpDir, alias, "dir");
    try {
      const processor = makeProcessor({ projectRoot: alias });
      processor.handleFileEvent("change", fs.realpathSync(filePath));
      expect(processor.progress.pendingFiles).toBe(1);
      (processor as any).startBatch();
      await (processor as any).activeBatch;

      expect(pool.processFile).toHaveBeenCalledWith(
        expect.objectContaining({
          absolutePath: path.join(alias, "sample.ts"),
          projectRoot: alias,
        }),
        expect.any(AbortSignal),
      );
    } finally {
      fs.unlinkSync(alias);
    }
  });

  it("rechecks policy after worker latency before committing vectors", async () => {
    const stats = fs.statSync(filePath);
    let classifications = 0;
    const changingPolicy = {
      isLexicallyContained: () => true,
      isPolicyFile: () => false,
      classifyFile: async () => {
        classifications++;
        return classifications === 1
          ? { status: "indexable", stat: stats }
          : { status: "excluded", reason: "new ignore rule" };
      },
    } as any;
    pool.processFile.mockResolvedValue({
      ...makeWorkerResult(filePath),
      vectors: [{ id: "new", path: filePath }],
    });
    const processor = makeProcessor({ filePolicy: changingPolicy });

    processor.handleFileEvent("change", filePath);
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(vectorDb.insertBatch).not.toHaveBeenCalled();
    expect(vectorDb.deletePaths).toHaveBeenCalledWith([filePath]);
    expect(metaCache.delete).toHaveBeenCalledWith(filePath);
  });
});
