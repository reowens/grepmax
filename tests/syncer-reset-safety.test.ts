import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({
  processFile: vi.fn(),
}));
const writeIndexConfig = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/workers/pool", async () => {
  const { resolveEmbeddingGeneration } = await import(
    "../src/lib/index/embedding-generation"
  );
  return {
    getWorkerPool: () => ({
      processFile: worker.processFile,
      encodeQuery: vi.fn(),
      generation: resolveEmbeddingGeneration({ modelTier: "small" }),
      embedMode: "cpu",
    }),
  };
});

vi.mock("../src/lib/index/index-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/index/index-config")>();
  return {
    ...actual,
    checkModelMismatch: () => false,
    writeIndexConfig,
  };
});

import { initialSync } from "../src/lib/index/syncer";
import type { MetaCache } from "../src/lib/store/meta-cache";
import type { VectorDB } from "../src/lib/store/vector-db";

describe("initialSync reset safety", () => {
  const roots: string[] = [];
  let previousEmbedMode: string | undefined;

  beforeEach(() => {
    previousEmbedMode = process.env.GMAX_EMBED_MODE;
    process.env.GMAX_EMBED_MODE = "cpu";
  });

  afterEach(() => {
    worker.processFile.mockReset();
    writeIndexConfig.mockReset();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    if (previousEmbedMode === undefined) delete process.env.GMAX_EMBED_MODE;
    else process.env.GMAX_EMBED_MODE = previousEmbedMode;
  });

  it("replaces observed files before deleting stale rows", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-reset-safe-"));
    roots.push(root);
    const source = path.join(root, "src.ts");
    const stale = path.join(root, "deleted.ts");
    fs.writeFileSync(source, "export const source = 1;\n");
    const stat = fs.statSync(source);
    const metadata = new Map([
      [source, { hash: "same", mtimeMs: stat.mtimeMs, size: stat.size }],
      [stale, { hash: "old", mtimeMs: 1, size: 1 }],
    ]);
    const metaCache = {
      get: (file: string) => metadata.get(file),
      getKeysWithPrefix: async () => new Set(metadata.keys()),
      put: (file: string, entry: any) => metadata.set(file, entry),
      delete: (file: string) => metadata.delete(file),
      close: async () => {},
    } as unknown as MetaCache;
    const vectorDb = {
      countDistinctFilesForPath: vi.fn(async () => 2),
      insertBatch: vi.fn(async () => {}),
      deletePathsExcludingIds: vi.fn(async () => {}),
      deletePaths: vi.fn(async () => {}),
      deletePathsWithPrefix: vi.fn(async () => {}),
      compactIfNeeded: vi.fn(async () => {}),
      runMaintenance: vi.fn(async () => {}),
      getDistinctPathsForPrefix: vi.fn(async () => new Set([source, stale])),
    } as unknown as VectorDB;
    worker.processFile.mockResolvedValue({
      hash: "same",
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      vectors: [{ id: "new", path: source }],
    });

    const result = await initialSync({
      projectRoot: root,
      reset: true,
      vectorDb,
      metaCache,
    });

    expect(result.degraded).toBe(false);
    expect(worker.processFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: root, absolutePath: source }),
      undefined,
    );
    expect(vectorDb.deletePathsWithPrefix).not.toHaveBeenCalled();
    expect(vectorDb.insertBatch).toHaveBeenCalled();
    expect(vectorDb.deletePathsExcludingIds).toHaveBeenCalledWith(
      [source],
      ["new"],
    );
    expect(vectorDb.deletePaths).toHaveBeenCalledWith([stale]);
    expect(writeIndexConfig).not.toHaveBeenCalled();
  });

  it("does not commit a reset generation when a worker fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-reset-fail-"));
    roots.push(root);
    const source = path.join(root, "src.ts");
    fs.writeFileSync(source, "export const source = 1;\n");
    const stat = fs.statSync(source);
    const metadata = new Map([
      [source, { hash: "old", mtimeMs: stat.mtimeMs, size: stat.size }],
    ]);
    const metaCache = {
      get: (file: string) => metadata.get(file),
      getKeysWithPrefix: async () => new Set(metadata.keys()),
      put: (file: string, entry: any) => metadata.set(file, entry),
      delete: (file: string) => metadata.delete(file),
      close: async () => {},
    } as unknown as MetaCache;
    const vectorDb = {
      countDistinctFilesForPath: vi.fn(async () => 1),
      insertBatch: vi.fn(async () => {}),
      deletePathsExcludingIds: vi.fn(async () => {}),
      deletePaths: vi.fn(async () => {}),
      compactIfNeeded: vi.fn(async () => {}),
      runMaintenance: vi.fn(async () => {}),
      getDistinctPathsForPrefix: vi.fn(async () => new Set([source])),
    } as unknown as VectorDB;
    worker.processFile.mockRejectedValue(new Error("embedding failed"));

    const result = await initialSync({
      projectRoot: root,
      reset: true,
      vectorDb,
      metaCache,
    });

    expect(result.degraded).toBe(true);
    expect(result.failedFiles).toBe(1);
    expect(vectorDb.deletePaths).not.toHaveBeenCalled();
    expect(metadata.has(source)).toBe(true);
    expect(writeIndexConfig).not.toHaveBeenCalled();
  });

  it("keeps metadata when vector deletion fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-delete-fail-"));
    roots.push(root);
    const source = path.join(root, "src.ts");
    fs.writeFileSync(source, "export const source = 1;\n");
    const stat = fs.statSync(source);
    const metadata = new Map([
      [source, { hash: "old", mtimeMs: stat.mtimeMs, size: stat.size }],
    ]);
    const metaCache = {
      get: (file: string) => metadata.get(file),
      getKeysWithPrefix: async () => new Set(metadata.keys()),
      put: (file: string, entry: any) => metadata.set(file, entry),
      delete: (file: string) => metadata.delete(file),
      close: async () => {},
    } as unknown as MetaCache;
    const vectorDb = {
      countDistinctFilesForPath: vi.fn(async () => 1),
      insertBatch: vi.fn(async () => {}),
      deletePathsExcludingIds: vi.fn(async () => {}),
      deletePaths: vi.fn(async () => {
        throw new Error("delete failed");
      }),
      compactIfNeeded: vi.fn(async () => {}),
      runMaintenance: vi.fn(async () => {}),
      getDistinctPathsForPrefix: vi.fn(async () => new Set([source])),
    } as unknown as VectorDB;
    const missing = new Error("gone") as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    worker.processFile.mockImplementation(async () => {
      fs.unlinkSync(source);
      throw missing;
    });

    await expect(
      initialSync({ projectRoot: root, reset: true, vectorDb, metaCache }),
    ).rejects.toThrow("delete failed");
    expect(metadata.has(source)).toBe(true);
  });

  it("preserves vectors when a worker ENOENT is stale by flush time", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-recreated-"));
    roots.push(root);
    const source = path.join(root, "src.ts");
    fs.writeFileSync(source, "export const source = 1;\n");
    const stat = fs.statSync(source);
    const metadata = new Map([
      [source, { hash: "old", mtimeMs: stat.mtimeMs, size: stat.size }],
    ]);
    const metaCache = {
      get: (file: string) => metadata.get(file),
      getKeysWithPrefix: async () => new Set(metadata.keys()),
      put: (file: string, entry: any) => metadata.set(file, entry),
      delete: (file: string) => metadata.delete(file),
      close: async () => {},
    } as unknown as MetaCache;
    const vectorDb = {
      countDistinctFilesForPath: vi.fn(async () => 1),
      insertBatch: vi.fn(async () => {}),
      deletePathsExcludingIds: vi.fn(async () => {}),
      deletePaths: vi.fn(async () => {}),
      compactIfNeeded: vi.fn(async () => {}),
      runMaintenance: vi.fn(async () => {}),
      getDistinctPathsForPrefix: vi.fn(async () => new Set([source])),
    } as unknown as VectorDB;
    const missing = new Error("transient rename") as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    worker.processFile.mockRejectedValue(missing);

    const result = await initialSync({
      projectRoot: root,
      reset: true,
      vectorDb,
      metaCache,
    });

    expect(result.degraded).toBe(true);
    expect(vectorDb.deletePaths).not.toHaveBeenCalled();
    expect(metadata.has(source)).toBe(true);
  });

  it("removes a newly ignored file before committing the generation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-policy-race-"));
    roots.push(root);
    const source = path.join(root, "src.ts");
    fs.writeFileSync(source, "export const source = 1;\n");
    const stat = fs.statSync(source);
    const metadata = new Map<string, any>();
    const metaCache = {
      get: (file: string) => metadata.get(file),
      getKeysWithPrefix: async () => new Set(metadata.keys()),
      put: (file: string, entry: any) => metadata.set(file, entry),
      delete: (file: string) => metadata.delete(file),
      close: async () => {},
    } as unknown as MetaCache;
    const vectorDb = {
      countDistinctFilesForPath: vi.fn(async () => 0),
      insertBatch: vi.fn(async () => {
        fs.writeFileSync(path.join(root, ".gitignore"), "src.ts\n");
      }),
      deletePathsExcludingIds: vi.fn(async () => {}),
      deletePaths: vi.fn(async () => {}),
      compactIfNeeded: vi.fn(async () => {}),
      runMaintenance: vi.fn(async () => {}),
      getDistinctPathsForPrefix: vi.fn(async () => new Set()),
    } as unknown as VectorDB;
    worker.processFile.mockResolvedValue({
      hash: "new",
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      vectors: [{ id: "new", path: source }],
    });

    const result = await initialSync({
      projectRoot: root,
      vectorDb,
      metaCache,
    });

    expect(result.degraded).toBe(false);
    expect(vectorDb.insertBatch).toHaveBeenCalled();
    expect(vectorDb.deletePaths).toHaveBeenCalledWith([source]);
    expect(metadata.has(source)).toBe(false);
    expect(writeIndexConfig).not.toHaveBeenCalled();
  });

  it("does not delete cached rows when the project root is unavailable", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-root-gone-"));
    roots.push(parent);
    const root = path.join(parent, "missing-project");
    const cached = path.join(root, "src.ts");
    const metadata = new Map([[cached, { hash: "old", mtimeMs: 1, size: 1 }]]);
    const metaCache = {
      get: (file: string) => metadata.get(file),
      getKeysWithPrefix: async () => new Set(metadata.keys()),
      put: (file: string, entry: any) => metadata.set(file, entry),
      delete: (file: string) => metadata.delete(file),
      close: async () => {},
    } as unknown as MetaCache;
    const vectorDb = {
      countDistinctFilesForPath: vi.fn(async () => 1),
      insertBatch: vi.fn(async () => {}),
      deletePathsExcludingIds: vi.fn(async () => {}),
      deletePaths: vi.fn(async () => {}),
      compactIfNeeded: vi.fn(async () => {}),
      runMaintenance: vi.fn(async () => {}),
      getDistinctPathsForPrefix: vi.fn(async () => new Set([cached])),
    } as unknown as VectorDB;

    const result = await initialSync({
      projectRoot: root,
      vectorDb,
      metaCache,
    });

    expect(result.degraded).toBe(true);
    expect(vectorDb.deletePaths).not.toHaveBeenCalled();
    expect(metadata.has(cached)).toBe(true);
    expect(writeIndexConfig).not.toHaveBeenCalled();
  });
});
