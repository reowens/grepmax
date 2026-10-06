import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISK_CRITICAL_BYTES } from "../src/config";
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

const GB = 1024 ** 3;
const success = {
  compaction: { fragmentsRemoved: 2, fragmentsAdded: 1 },
  prune: { oldVersionsRemoved: 3, bytesRemoved: GB },
};
const conflict = () =>
  new Error(
    "Retryable commit conflict: Rewrite preempted by concurrent Delete",
  );

function table(
  optimize: ReturnType<typeof vi.fn> = vi.fn(async () => success),
) {
  return { optimize, stats: vi.fn(async () => ({ totalBytes: 14 * GB })) };
}

describe("VectorDB compaction safety", () => {
  let root: string;
  let db: VectorDB;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-compaction-safety-"));
    db = new VectorDB(path.join(root, "lancedb"), 384);
    vi.spyOn(db, "getAvailableBytes").mockReturnValue(100 * GB);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("opens the snapshot after an outstanding delete commits", async () => {
    let finishDelete!: () => void;
    const pendingDelete = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    let version = 1;
    const write = (db as any).withWriteGate(async () => {
      await pendingDelete;
      version = 2;
    });
    let snapshotVersion = 0;
    const open = vi
      .spyOn(db as any, "ensureTableUnsafe")
      .mockImplementation(async () => {
        snapshotVersion = version;
        return table();
      });
    const optimize = db.optimize();
    await Promise.resolve();
    await Promise.resolve();
    const openedBeforeDeleteFinished = open.mock.calls.length > 0;
    finishDelete();
    await Promise.all([write, optimize]);

    expect(openedBeforeDeleteFinished).toBe(false);
    expect(snapshotVersion).toBe(2);
  });

  it("opens a fresh snapshot for the conflict retry", async () => {
    vi.useFakeTimers();
    const stale = table(vi.fn().mockRejectedValue(conflict()));
    const fresh = table();
    const open = vi
      .spyOn(db as any, "ensureTableUnsafe")
      .mockResolvedValueOnce(stale)
      .mockResolvedValue(fresh);

    const pending = db.optimize(5);
    await vi.runAllTimersAsync();
    await pending;

    expect(open).toHaveBeenCalledTimes(2);
    expect(stale.optimize).toHaveBeenCalledOnce();
    expect(fresh.optimize).toHaveBeenCalledOnce();
    expect((db as any).lastOptimizeDidWork).toBe(true);
    expect(
      fresh.optimize.mock.calls[0][0].cleanupOlderThan.getTime(),
    ).toBeGreaterThan(
      stale.optimize.mock.calls[0][0].cleanupOlderThan.getTime(),
    );
  });

  it("caps repeated conflicts at two rewrites even when five are requested", async () => {
    vi.useFakeTimers();
    const failed = table(vi.fn().mockRejectedValue(conflict()));
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(failed);

    const pending = db.optimize(5);
    await vi.runAllTimersAsync();
    await pending;

    expect(failed.optimize).toHaveBeenCalledTimes(2);
    expect((db as any).lastOptimizeDidWork).toBe(false);
  });

  it("checks fresh free space after a failed attempt consumes disk", async () => {
    vi.useFakeTimers();
    const failed = table(vi.fn().mockRejectedValue(conflict()));
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(failed);
    vi.mocked(db.getAvailableBytes)
      .mockReturnValueOnce(44 * GB)
      .mockReturnValue(20 * GB);
    // A pressure check can remain cached as 'ok' for 30 seconds.
    vi.spyOn(db, "checkDiskPressure").mockReturnValue("ok");

    const pending = db.optimize(5);
    await vi.runAllTimersAsync();
    await pending;

    expect(failed.optimize).toHaveBeenCalledOnce();
    expect(
      vi.mocked(db.getAvailableBytes).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("preserves a critical-space reserve and releases queued writes on skip", async () => {
    const current = table();
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(current);
    vi.mocked(db.getAvailableBytes).mockReturnValue(
      28 * GB + DISK_CRITICAL_BYTES - 1,
    );

    const pending = db.optimize();
    const write = vi.fn(async () => {});
    const queued = (db as any).withWriteGate(write);
    await Promise.all([pending, queued]);

    expect(current.optimize).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    expect((db as any).activeCompactions).toBe(0);
  });

  it("allows a rewrite with exactly enough estimated headroom", async () => {
    const current = table();
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(current);
    vi.mocked(db.getAvailableBytes).mockReturnValue(
      28 * GB + DISK_CRITICAL_BYTES,
    );

    await db.optimize();

    expect(current.optimize).toHaveBeenCalledOnce();
  });

  it("does not retry an out-of-space failure and releases the write gate", async () => {
    const current = table(
      vi.fn().mockRejectedValue(new Error("No space left on device")),
    );
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(current);

    await db.optimize(5);
    const write = vi.fn(async () => {});
    await (db as any).withWriteGate(write);

    expect(current.optimize).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
  });

  it("skips a rewrite when its size cannot be measured", async () => {
    const current = table();
    current.stats.mockRejectedValue(new Error("Cannot read table metadata"));
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(current);

    await db.optimize();

    expect(current.optimize).not.toHaveBeenCalled();
    expect((db as any).activeCompactions).toBe(0);
  });

  it("records disk growth and bounded diagnostics when both attempts fail", async () => {
    vi.useFakeTimers();
    const failed = table(vi.fn().mockRejectedValue(conflict()));
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(failed);
    vi.spyOn(db as any, "getDirectorySize")
      .mockReturnValueOnce(87 * GB)
      .mockReturnValueOnce(101 * GB)
      .mockReturnValueOnce(101 * GB)
      .mockReturnValue(115 * GB);
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const pending = db.optimize(5);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toMatchObject({
        status: "failed",
        attempts: 2,
        logicalBytes: 14 * GB,
        diskBytesBefore: 87 * GB,
        diskBytesAfter: 115 * GB,
      });
      expect(db.compactionStatus()).toEqual(result);
      const lines = output.mock.calls.map(([line]) => String(line));
      expect(
        lines.filter((line) => line.includes("Compaction attempt: ")),
      ).toHaveLength(2);
      expect(
        lines.filter((line) => line.includes("Compaction result: ")),
      ).toHaveLength(1);
    } finally {
      output.mockRestore();
    }
  });

  it("reports insufficient headroom as skipped without claiming an attempt", async () => {
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(table());
    vi.mocked(db.getAvailableBytes).mockReturnValue(10 * GB);
    expect(await db.optimize()).toMatchObject({
      status: "skipped",
      attempts: 0,
    });
  });
});
