import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";

const TICK_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

describe("VectorDB maintenance gating", () => {
  let root: string;
  let db: VectorDB;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00Z"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-maintenance-gate-"));
    db = new VectorDB(path.join(root, "lancedb"), 384);
    vi.spyOn(db, "createVectorIndex").mockResolvedValue(false);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function markClean(version = 7): void {
    (db as any).maintainedEpoch = (db as any).writeEpoch;
    (db as any).maintainedTableVersion = version;
    (db as any).ftsIndexEnsured = true;
    (db as any).lastMaintenanceMs = Date.now();
  }

  it("skips clean timer ticks before entering the operation runner", async () => {
    markClean();
    const runner = vi.fn(async (fn: () => Promise<void>) => fn());
    const maintenance = vi.spyOn(db, "runMaintenance");
    db.startMaintenanceLoop(runner);

    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(runner).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
    expect(db.isMaintenanceActive()).toBe(false);
  });

  it("always runs the first timer tick on a fresh instance", async () => {
    const runner = vi.fn(async (fn: () => Promise<void>) => fn());
    vi.spyOn(db, "runMaintenance").mockResolvedValue(undefined);
    db.startMaintenanceLoop(runner);

    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(runner).toHaveBeenCalledOnce();
    expect(db.runMaintenance).toHaveBeenCalledOnce();
  });

  it("hourly probes skip a full pass when the table version is unchanged", async () => {
    markClean(7);
    (db as any).lastMaintenanceMs = Date.now() - HOUR_MS;
    const table = { version: vi.fn(async () => 7) };
    vi.spyOn(db as any, "openExistingTableUnsafe").mockResolvedValue(table);
    const fts = vi.spyOn(db, "createFTSIndex").mockResolvedValue(undefined);
    const optimize = vi.spyOn(db, "optimize").mockResolvedValue(undefined);

    await db.runMaintenance();

    expect(table.version).toHaveBeenCalledOnce();
    expect(fts).not.toHaveBeenCalled();
    expect(optimize).not.toHaveBeenCalled();
    expect((db as any).lastMaintenanceMs).toBe(Date.now());
  });

  it("runs a full pass when the hourly probe sees an external write", async () => {
    markClean(7);
    (db as any).lastMaintenanceMs = Date.now() - HOUR_MS;
    const table = {
      version: vi.fn(async () => 8),
      stats: vi.fn(async () => ({ totalBytes: 1 })),
    };
    vi.spyOn(db as any, "openExistingTableUnsafe").mockResolvedValue(table);
    const fts = vi.spyOn(db, "createFTSIndex").mockResolvedValue(undefined);
    const optimize = vi.spyOn(db, "optimize").mockResolvedValue(undefined);

    await db.runMaintenance();

    expect(fts).toHaveBeenCalledOnce();
    expect(optimize).toHaveBeenCalledOnce();
    expect((db as any).maintainedTableVersion).toBe(8);
  });

  it("does not lose a write committed during maintenance", async () => {
    const table = { version: vi.fn(async () => 9) };
    vi.spyOn(db as any, "openExistingTableUnsafe").mockResolvedValue(table);
    vi.spyOn(db, "createFTSIndex").mockResolvedValue(undefined);
    vi.spyOn(db, "optimize").mockImplementation(async () => {
      (db as any).markWriteCommitted();
    });

    await db.runMaintenance({ force: true });

    expect((db as any).writeEpoch).toBe(1);
    expect((db as any).maintainedEpoch).toBe(0);
    expect((db as any).maintenanceDue()).toBe(true);
  });

  it("skips the directory bloat scan when optimize did no work", async () => {
    const table = {
      version: vi.fn(async () => 10),
      stats: vi.fn(async () => ({ totalBytes: 1 })),
    };
    vi.spyOn(db as any, "openExistingTableUnsafe").mockResolvedValue(table);
    vi.spyOn(db, "createFTSIndex").mockResolvedValue(undefined);
    vi.spyOn(db, "optimize").mockResolvedValue(undefined);
    const directorySize = vi.spyOn(db as any, "getDirectorySize");

    await db.runMaintenance({ force: true });

    expect(table.stats).not.toHaveBeenCalled();
    expect(directorySize).not.toHaveBeenCalled();
  });

  it("ordinary ensureTable calls do not dirty a clean instance", async () => {
    markClean();
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue({});

    await db.ensureTable();
    await db.ensureTable();
    await db.ensureTable();

    expect((db as any).writeEpoch).toBe(0);
    expect((db as any).maintenanceDue()).toBe(false);
  });

  it("dirties only when public mutation methods commit work", async () => {
    let existingRows: unknown[] = [];
    const query: any = {
      select: () => query,
      where: () => query,
      limit: () => query,
      toArray: async () => existingRows,
    };
    const table = {
      query: () => query,
      add: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
    };
    vi.spyOn(db as any, "openExistingTableUnsafe").mockResolvedValue(table);
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(table);

    await db.deletePaths(["/repo/no-op.ts"]);
    expect((db as any).writeEpoch).toBe(0);

    existingRows = [{ id: "old" }];
    await db.deletePaths(["/repo/file.ts"]);
    await db.deletePathsExcludingIds(["/repo/file.ts"], ["new"]);
    await db.deletePathsWithPrefix("/repo");
    await db.updateRows(["row"], "summary", ["updated"]);
    const record = {
      ...(db as any).seedRow(),
      id: "new",
      path: "/repo/file.ts",
    };
    await db.insertBatch([record]);

    expect((db as any).writeEpoch).toBe(5);
    expect((db as any).maintenanceDue()).toBe(true);
  });
});
