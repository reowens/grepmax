import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";

// Historical native algorithm coverage only; production policy has no override.
vi.mock("../src/lib/store/maintenance-policy", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/lib/store/maintenance-policy")
    >();
  return {
    ...original,
    assertStoreMutationAllowed: () => {},
    storeMutationDeniedReason: () => null,
    fullTableMaintenanceDisabled: () => false,
    recordMaintenanceContainment: () =>
      "test-only historical algorithm fixture",
  };
});

const rewrite = {
  compaction: { fragmentsRemoved: 3, fragmentsAdded: 1 },
  prune: { oldVersionsRemoved: 2, bytesRemoved: 100 },
};
const pruned = {
  compaction: { fragmentsRemoved: 0, fragmentsAdded: 0 },
  prune: { oldVersionsRemoved: 1, bytesRemoved: 200 },
};

describe("bounded post-compaction cleanup", () => {
  let dir: string;
  let db: VectorDB;
  let source: any;
  let fresh: any;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T00:00:01Z"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-cleanup-"));
    db = new VectorDB(dir, 4);
    const stats = () => ({
      totalBytes: 1000,
      fragmentStats: { numFragments: 1 },
    });
    source = {
      stats: vi.fn(async () => stats()),
      version: vi.fn(async () => 5),
      optimize: vi.fn(async () => rewrite),
    };
    fresh = {
      stats: vi.fn(async () => stats()),
      version: vi.fn(async () => 5),
      listVersions: vi.fn(async () => [
        {
          version: 5,
          timestamp: new Date("2026-10-06T00:00:00Z"),
          metadata: {
            total_fragments: "1",
            total_deletion_files: "0",
            total_deletion_file_rows: "0",
          },
        },
      ]),
      optimize: vi.fn(async () => pruned),
    };
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(source);
    vi.spyOn(db as any, "openExistingTableUnsafe").mockResolvedValue(fresh);
    vi.spyOn(db, "getAvailableBytes").mockReturnValue(100 * 1024 ** 3);
    vi.spyOn(db as any, "getDirectorySize").mockReturnValue(4000);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function optimize(retentionMs = 0) {
    const result = db.optimize(2, retentionMs);
    await vi.advanceTimersByTimeAsync(5);
    return result;
  }
  it("uses a real later cutoff once and reports gross versus net bytes", async () => {
    fresh.optimize.mockImplementation(async () => {
      vi.spyOn(db as any, "getDirectorySize").mockReturnValue(2000);
      return pruned;
    });
    const result = await optimize();
    expect(source.optimize).toHaveBeenCalledOnce();
    expect(fresh.optimize).toHaveBeenCalledOnce();
    const cutoff = fresh.optimize.mock.calls[0][0].cleanupOlderThan.getTime();
    expect(cutoff).toBeGreaterThan(
      source.optimize.mock.calls[0][0].cleanupOlderThan.getTime(),
    );
    expect(cutoff).toBeLessThanOrEqual(Date.now());
    expect(result).toMatchObject({
      status: "completed",
      attempts: 1,
      cleanupPasses: 1,
      bytesReclaimed: 300,
      netBytesReclaimed: 2000,
    });
  });
  it("keeps queued writes outside the complete cleanup window", async () => {
    let finish!: (value: typeof pruned) => void;
    fresh.optimize.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = db.optimize();
    await vi.advanceTimersByTimeAsync(5);
    const entered = vi.fn();
    const write = (db as any).withWriteGate(async () => entered());
    await Promise.resolve();
    expect(entered).not.toHaveBeenCalled();
    finish(pruned);
    await Promise.all([pending, write]);
    expect(entered).toHaveBeenCalledOnce();
  });
  it("does not advance an explicitly requested retention cutoff", async () => {
    await optimize(60000);
    expect(fresh.optimize).not.toHaveBeenCalled();
    expect(source.optimize.mock.calls[0][0].cleanupOlderThan.getTime()).toBe(
      Date.now() - 60005,
    );
  });
  it("preserves an external post-compaction commit by declining cleanup", async () => {
    fresh.version.mockResolvedValue(6);
    const result = await optimize();
    expect(fresh.optimize).not.toHaveBeenCalled();
    expect(result.cleanupReason).toContain("table changed");
  });
  it("declines another rewrite when multiple fragments remain", async () => {
    source.stats.mockResolvedValue({
      totalBytes: 1000,
      fragmentStats: { numFragments: 2 },
    });
    const result = await optimize();
    expect(fresh.optimize).not.toHaveBeenCalled();
    expect(result.cleanupReason).toContain("not a single fragment");
  });
  it("requires deletion-free manifest evidence", async () => {
    fresh.listVersions.mockResolvedValue([
      {
        version: 5,
        timestamp: new Date(0),
        metadata: {
          total_fragments: "1",
          total_deletion_files: "1",
          total_deletion_file_rows: "1",
        },
      },
    ]);
    const result = await optimize();
    expect(fresh.optimize).not.toHaveBeenCalled();
    expect(result.cleanupReason).toContain("not verified");
  });
  it("checks fresh headroom before the cleanup binding", async () => {
    vi.spyOn(db, "getAvailableBytes")
      .mockReturnValueOnce(100 * 1024 ** 3)
      .mockReturnValue(3 * 1024 ** 3);
    const result = await optimize();
    expect(fresh.optimize).not.toHaveBeenCalled();
    expect(result.cleanupReason).toContain("headroom");
  });
  it("declines cleanup if the clock has not passed the manifest timestamp", async () => {
    const versions = await fresh.listVersions();
    versions[0].timestamp = new Date(Date.now() + 1000);
    fresh.listVersions.mockResolvedValue(versions);
    const result = await optimize();
    expect(fresh.optimize).not.toHaveBeenCalled();
    expect(result.cleanupReason).toContain("clock");
  });
  it("never retries the full rewrite after a cleanup error", async () => {
    fresh.optimize.mockRejectedValue(new Error("Retryable cleanup conflict"));
    const result = await optimize();
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("cleanup failed");
    expect(source.optimize).toHaveBeenCalledOnce();
    expect(fresh.optimize).toHaveBeenCalledOnce();
    const entered = vi.fn();
    await (db as any).withWriteGate(async () => entered());
    expect(entered).toHaveBeenCalledOnce();
  });
  it("does not turn cleanup failure into a maintenance bloat rewrite", async () => {
    vi.spyOn(db, "createFTSIndex").mockResolvedValue(undefined);
    vi.spyOn(db, "createVectorIndex").mockResolvedValue(false);
    vi.spyOn(db as any, "getDirectorySize").mockReturnValue(100000);
    fresh.optimize.mockRejectedValue(new Error("Retryable cleanup conflict"));
    const pending = db.runMaintenance({ force: true });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(result?.status).toBe("failed");
    expect(source.optimize).toHaveBeenCalledOnce();
    expect(fresh.optimize).toHaveBeenCalledOnce();
  });
  it("reports an unexpected cleanup rewrite without another attempt", async () => {
    fresh.optimize.mockResolvedValue(rewrite);
    const result = await optimize();
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("unexpectedly rewrote");
    expect(source.optimize).toHaveBeenCalledOnce();
    expect(fresh.optimize).toHaveBeenCalledOnce();
  });
});
