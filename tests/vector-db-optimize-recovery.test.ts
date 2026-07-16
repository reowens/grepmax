import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";

const okStats = {
  compaction: { fragmentsRemoved: 2, fragmentsAdded: 1 },
  prune: { oldVersionsRemoved: 3, bytesRemoved: 1024 },
};

const panic = () => new Error("Panic in async function");

function fakeTable(optimize: ReturnType<typeof vi.fn>) {
  return {
    optimize,
    dropIndex: vi.fn(async () => {}),
    createIndex: vi.fn(async () => {}),
  };
}

describe("VectorDB optimize panic recovery", () => {
  let root: string;
  let db: VectorDB;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-optimize-recovery-"));
    db = new VectorDB(path.join(root, "lancedb"), 384);
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function inject(table: ReturnType<typeof fakeTable>) {
    (db as any).ensureTableUnsafe = vi.fn(async () => table);
  }

  it("rebuilds the FTS index and retries after a panic", async () => {
    const optimize = vi
      .fn()
      .mockRejectedValueOnce(panic())
      .mockResolvedValue(okStats);
    const table = fakeTable(optimize);
    inject(table);

    await db.optimize(5, 0, true);

    expect(table.dropIndex).toHaveBeenCalledWith("content_idx");
    expect(table.createIndex).toHaveBeenCalledTimes(1);
    expect(optimize).toHaveBeenCalledTimes(2);
  });

  it("does not rebuild for non-panic errors", async () => {
    const optimize = vi.fn().mockRejectedValue(new Error("io error"));
    const table = fakeTable(optimize);
    inject(table);

    await db.optimize(5, 0, true);

    expect(table.dropIndex).not.toHaveBeenCalled();
    expect(table.createIndex).not.toHaveBeenCalled();
    expect(optimize).toHaveBeenCalledTimes(1);
  });

  it("latches after a rebuild that does not stop the panic", async () => {
    const optimize = vi.fn().mockRejectedValue(panic());
    const table = fakeTable(optimize);
    inject(table);

    await db.optimize(5, 0, true);
    expect(table.createIndex).toHaveBeenCalledTimes(1);
    expect(optimize).toHaveBeenCalledTimes(2);

    // Next maintenance tick: still panicking, but no second rebuild.
    await db.optimize(5, 0, true);
    expect(table.createIndex).toHaveBeenCalledTimes(1);
    expect(optimize).toHaveBeenCalledTimes(3);
  });

  it("clears the latch after a successful optimize", async () => {
    const optimize = vi.fn().mockRejectedValue(panic());
    const table = fakeTable(optimize);
    inject(table);

    await db.optimize(5, 0, true);
    expect(table.createIndex).toHaveBeenCalledTimes(1);

    optimize.mockResolvedValueOnce(okStats);
    await db.optimize(5, 0, true);

    optimize.mockRejectedValueOnce(panic()).mockResolvedValue(okStats);
    await db.optimize(5, 0, true);
    expect(table.createIndex).toHaveBeenCalledTimes(2);
  });

  it("latches when the rebuild itself fails", async () => {
    const optimize = vi.fn().mockRejectedValue(panic());
    const table = fakeTable(optimize);
    // createFTSIndexUnsafe swallows createIndex failures (warns and
    // returns), so the flow is rebuild-attempt -> retry -> panic -> latch.
    table.createIndex.mockRejectedValue(new Error("rebuild broke"));
    inject(table);

    await db.optimize(5, 0, true);
    expect(table.createIndex).toHaveBeenCalledTimes(1);
    expect(optimize).toHaveBeenCalledTimes(2);

    await db.optimize(5, 0, true);
    expect(table.createIndex).toHaveBeenCalledTimes(1);
    expect(optimize).toHaveBeenCalledTimes(3);
  });
});
