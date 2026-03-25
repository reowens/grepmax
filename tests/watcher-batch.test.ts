import { describe, expect, it, vi } from "vitest";
import {
  computeRetryAction,
  flushBatchToDb,
  processBatchCore,
} from "../src/lib/index/watcher-batch";

function mockPool(overrides: Record<string, any> = {}) {
  return {
    processFile: vi.fn(async () => ({
      vectors: [{ id: "v1", path: "/a.ts" }] as any[],
      hash: "newhash",
      mtimeMs: 2000,
      size: 100,
      shouldDelete: false,
      ...overrides,
    })),
  };
}

function mockMetaCache(entries: Record<string, any> = {}) {
  return {
    get: (p: string) => entries[p],
  };
}

// Mock fs.promises.stat
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...(actual as any),
    promises: {
      ...(actual as any).promises,
      stat: vi.fn(async () => ({ size: 100, mtimeMs: 2000, isFile: () => true })),
    },
  };
});

describe("processBatchCore", () => {
  it("skips files with matching mtime/size (cache hit)", async () => {
    const pool = mockPool();
    const cache = mockMetaCache({
      "/src/a.ts": { hash: "abc", mtimeMs: 2000, size: 100 },
    });

    const batch = new Map<string, "change" | "unlink">([
      ["/src/a.ts", "change"],
    ]);
    const result = await processBatchCore(batch, cache, pool);

    expect(pool.processFile).not.toHaveBeenCalled();
    expect(result.reindexed).toBe(0);
  });

  it("processes files with different mtime (cache miss)", async () => {
    const pool = mockPool();
    const cache = mockMetaCache({
      "/src/a.ts": { hash: "oldhash", mtimeMs: 1000, size: 100 },
    });

    const batch = new Map<string, "change" | "unlink">([
      ["/src/a.ts", "change"],
    ]);
    const result = await processBatchCore(batch, cache, pool);

    expect(pool.processFile).toHaveBeenCalled();
    expect(result.reindexed).toBe(1);
    expect(result.vectors.length).toBe(1);
  });

  it("skips re-embedding when hash matches despite mtime change", async () => {
    const pool = mockPool({ hash: "samehash" });
    const cache = mockMetaCache({
      "/src/a.ts": { hash: "samehash", mtimeMs: 1000, size: 50 },
    });

    const batch = new Map<string, "change" | "unlink">([
      ["/src/a.ts", "change"],
    ]);
    const result = await processBatchCore(batch, cache, pool);

    expect(result.reindexed).toBe(0);
    expect(result.metaUpdates.has("/src/a.ts")).toBe(true);
  });

  it("handles unlink events as deletions", async () => {
    const pool = mockPool();
    const cache = mockMetaCache();

    const batch = new Map<string, "change" | "unlink">([
      ["/src/deleted.ts", "unlink"],
    ]);
    const result = await processBatchCore(batch, cache, pool);

    expect(result.deletes).toContain("/src/deleted.ts");
    expect(result.metaDeletes).toContain("/src/deleted.ts");
    expect(result.reindexed).toBe(1);
    expect(pool.processFile).not.toHaveBeenCalled();
  });

  it("handles shouldDelete result from worker", async () => {
    const pool = mockPool({ shouldDelete: true, vectors: [] });
    const cache = mockMetaCache();

    const batch = new Map<string, "change" | "unlink">([
      ["/src/temp.ts", "change"],
    ]);
    const result = await processBatchCore(batch, cache, pool);

    expect(result.deletes).toContain("/src/temp.ts");
    expect(result.reindexed).toBe(1);
  });

  it("tracks changedIds from new vectors", async () => {
    const pool = mockPool({
      vectors: [
        { id: "chunk-1", path: "/a.ts" },
        { id: "chunk-2", path: "/a.ts" },
      ],
    });
    const cache = mockMetaCache();

    const batch = new Map<string, "change" | "unlink">([
      ["/src/a.ts", "change"],
    ]);
    const result = await processBatchCore(batch, cache, pool);

    expect(result.changedIds).toContain("chunk-1");
    expect(result.changedIds).toContain("chunk-2");
  });

  it("respects pre-aborted signal", async () => {
    const pool = mockPool();
    const cache = mockMetaCache();
    const ac = new AbortController();
    ac.abort();

    const batch = new Map<string, "change" | "unlink">([
      ["/src/a.ts", "change"],
      ["/src/b.ts", "change"],
    ]);
    const result = await processBatchCore(batch, cache, pool, ac.signal);

    expect(pool.processFile).not.toHaveBeenCalled();
    expect(result.reindexed).toBe(0);
  });

  it("aborts mid-batch when signal fires", async () => {
    const ac = new AbortController();
    const pool = {
      processFile: vi.fn(async () => {
        ac.abort();
        return {
          vectors: [{ id: "v1", path: "/a.ts" }] as any[],
          hash: "newhash",
          mtimeMs: 2000,
          size: 100,
          shouldDelete: false,
        };
      }),
    };
    const cache = mockMetaCache();

    const batch = new Map<string, "change" | "unlink">([
      ["/src/a.ts", "change"],
      ["/src/b.ts", "change"],
      ["/src/c.ts", "change"],
    ]);
    const result = await processBatchCore(batch, cache, pool, ac.signal);

    expect(pool.processFile).toHaveBeenCalledTimes(1);
    expect(result.reindexed).toBe(1);
  });

  it("passes signal to pool.processFile", async () => {
    const pool = mockPool();
    const cache = mockMetaCache();
    const ac = new AbortController();

    const batch = new Map<string, "change" | "unlink">([
      ["/src/a.ts", "change"],
    ]);
    await processBatchCore(batch, cache, pool, ac.signal);

    expect(pool.processFile).toHaveBeenCalledWith(
      { path: "/src/a.ts", absolutePath: "/src/a.ts" },
      ac.signal,
    );
  });
});

describe("flushBatchToDb", () => {
  it("inserts before deleting with exclusion", async () => {
    const callOrder: string[] = [];
    const db = {
      insertBatch: vi.fn(async () => { callOrder.push("insert"); }),
      deletePathsExcludingIds: vi.fn(async () => { callOrder.push("deleteExcluding"); }),
      deletePaths: vi.fn(async () => { callOrder.push("delete"); }),
    };

    await flushBatchToDb(
      {
        reindexed: 1,
        changedIds: ["v1"],
        vectors: [{ id: "v1" }] as any[],
        deletes: ["/old.ts"],
        metaUpdates: new Map(),
        metaDeletes: [],
      },
      db,
    );

    expect(callOrder).toEqual(["insert", "deleteExcluding"]);
  });

  it("uses deletePaths for pure unlinks (no new vectors)", async () => {
    const db = {
      insertBatch: vi.fn(),
      deletePathsExcludingIds: vi.fn(),
      deletePaths: vi.fn(),
    };

    await flushBatchToDb(
      {
        reindexed: 1,
        changedIds: [],
        vectors: [],
        deletes: ["/deleted.ts"],
        metaUpdates: new Map(),
        metaDeletes: ["/deleted.ts"],
      },
      db,
    );

    expect(db.insertBatch).not.toHaveBeenCalled();
    expect(db.deletePaths).toHaveBeenCalledWith(["/deleted.ts"]);
    expect(db.deletePathsExcludingIds).not.toHaveBeenCalled();
  });
});

describe("computeRetryAction", () => {
  it("re-queues files under max retries", () => {
    const batch = new Map([["a.ts", "change" as const]]);
    const retryCount = new Map<string, number>();

    const result = computeRetryAction(batch, retryCount, 5, false, 0, 2000);

    expect(result.requeued.size).toBe(1);
    expect(result.dropped).toBe(0);
    expect(retryCount.get("a.ts")).toBe(1);
  });

  it("drops files at max retries", () => {
    const batch = new Map([["a.ts", "change" as const]]);
    const retryCount = new Map([["a.ts", 4]]);

    const result = computeRetryAction(batch, retryCount, 5, false, 0, 2000);

    expect(result.requeued.size).toBe(0);
    expect(result.dropped).toBe(1);
  });

  it("uses exponential backoff on lock errors", () => {
    const batch = new Map([["a.ts", "change" as const]]);
    const retryCount = new Map<string, number>();

    const r1 = computeRetryAction(batch, retryCount, 5, true, 0, 2000);
    expect(r1.backoffMs).toBe(4000); // 2000 * 2^1

    const r2 = computeRetryAction(batch, retryCount, 5, true, 2, 2000);
    expect(r2.backoffMs).toBe(16000); // 2000 * 2^3
  });

  it("caps backoff at 30 seconds", () => {
    const batch = new Map([["a.ts", "change" as const]]);
    const retryCount = new Map<string, number>();

    const result = computeRetryAction(batch, retryCount, 5, true, 10, 2000);
    expect(result.backoffMs).toBe(30000);
  });
});
