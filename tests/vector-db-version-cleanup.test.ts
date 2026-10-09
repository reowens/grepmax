import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";
import { runVersionCleanup } from "../src/lib/store/version-cleanup";

vi.mock("../src/lib/store/version-cleanup", () => ({
  runVersionCleanup: vi.fn(),
}));
vi.mock("../src/lib/store/maintenance-policy", async (original) => ({
  ...(await original<typeof import("../src/lib/store/maintenance-policy")>()),
  assertStoreMutationAllowed: () => {},
  storeMutationDeniedReason: () => null,
}));
describe("VectorDB prune-only read window", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  });
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-cleanup-reader-"));
    roots.push(root);
    const db = new VectorDB(root, 4);
    const d = db as any;
    const lease = {} as any;
    vi.spyOn(db, "upgradeStoreLease").mockResolvedValue(lease);
    vi.spyOn(db, "downgradeStoreLease").mockResolvedValue(lease);
    const table = { version: async () => 5, close: vi.fn() };
    vi.spyOn(d, "openExistingTableUnsafe").mockResolvedValue(table);
    vi.spyOn(d, "validateSchema").mockResolvedValue(undefined);
    d.db = { close: vi.fn() };
    const connection = d.db;
    d.resourceReservation = { release: vi.fn() };
    const reservation = d.resourceReservation;
    return { db, d, table, connection, reservation };
  }
  it("closes older native handles, admits read-only current access and excludes schema evolution/writes", async () => {
    const f = fixture();
    const evolve = vi.spyOn(f.d, "ensureTableUnsafe");
    const write = vi.fn(async () => {});
    const readWindow = vi.fn(() => {
      expect(f.connection.close).toHaveBeenCalled();
      expect(f.reservation.release).toHaveBeenCalled();
    });
    vi.mocked(runVersionCleanup).mockImplementation(async () => {
      expect(f.db.isMaintenanceActive()).toBe(true);
      await expect(f.db.ensureTable()).resolves.toBe(f.table);
      await expect(f.d.withWriteGate(write)).rejects.toThrow("writes paused");
      return {
        status: "completed",
        at: 1,
        attempts: 1,
        elapsedMs: 1,
        rewritten: false,
        versionsRemoved: 1,
        eligibleVersionsRemaining: 0,
      };
    });
    await f.db.cleanupVersions(
      { python: "fixture", script: "prune.py" },
      undefined,
      readWindow,
    );
    expect(readWindow).toHaveBeenCalledOnce();
    expect(evolve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(f.db.downgradeStoreLease).toHaveBeenCalledOnce();
    expect(f.db.isMaintenanceActive()).toBe(false);
    await f.db.close();
  });
  it("restores shared ownership and the write gate after a helper failure", async () => {
    const f = fixture();
    vi.mocked(runVersionCleanup).mockRejectedValueOnce(
      new Error("interrupted"),
    );
    await expect(
      f.db.cleanupVersions({ python: "fixture", script: "prune.py" }),
    ).rejects.toThrow("interrupted");
    expect(f.db.downgradeStoreLease).toHaveBeenCalledOnce();
    expect(f.db.isMaintenanceActive()).toBe(false);
    await expect(f.d.withWriteGate(async () => "resumed")).resolves.toBe(
      "resumed",
    );
    await f.db.close();
  });
});
