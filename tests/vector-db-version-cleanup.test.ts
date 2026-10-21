import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";
import { runVersionCleanup } from "../src/lib/store/version-cleanup";
import { resourceBudget } from "../src/lib/utils/resource-budget";

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
  it("keeps restricted document reads usable during and after prune without ordinary work", async () => {
    const f = fixture();
    const current = { version: async () => 5, close: vi.fn() };
    const reopened = { openTable: vi.fn(async () => current), close: vi.fn() };
    vi.mocked(f.d.openExistingTableUnsafe).mockImplementation(async () => {
      if (!f.d.db) f.d.db = reopened;
      return current;
    });
    const getDb = vi.spyOn(f.d, "getDb");
    const ensure = vi.spyOn(f.d, "ensureTableUnsafe");
    const readWindow = vi.fn(() => expect(f.d.db).toBe(reopened));
    vi.mocked(runVersionCleanup).mockImplementation(async () => {
      expect(await f.db.existingTableForRead()).toBe(current);
      return {
        status: "completed",
        at: 1,
        attempts: 1,
        elapsedMs: 1,
        rewritten: false,
        versionsRemoved: 0,
        eligibleVersionsRemaining: 0,
      };
    });
    try {
      await f.db.cleanupVersions(
        { python: "fixture", script: "prune.py" },
        undefined,
        readWindow,
      );
      expect(await f.db.existingTableForRead()).toBe(current);
      expect(readWindow).toHaveBeenCalledOnce();
      expect(getDb).not.toHaveBeenCalled();
      expect(ensure).not.toHaveBeenCalled();
    } finally {
      await f.db.close();
    }
  });
  it.each(["missing", "changed", "failed"])(
    "refuses an unverified %s read connection before opening the window or pruning",
    async (kind) => {
      const f = fixture();
      const current = { version: async () => 6, close: vi.fn() };
      const open = vi.mocked(f.d.openExistingTableUnsafe);
      open.mockReset().mockResolvedValueOnce(f.table);
      if (kind === "failed")
        open.mockRejectedValueOnce(new Error("open failed"));
      else open.mockResolvedValueOnce(kind === "missing" ? null : current);
      const window = vi.fn();
      try {
        await expect(
          f.db.cleanupVersions(
            { python: "fixture", script: "prune.py" },
            undefined,
            window,
          ),
        ).rejects.toThrow(
          kind === "missing"
            ? "table unavailable"
            : kind === "changed"
              ? "head changed"
              : "open failed",
        );
        expect(window).not.toHaveBeenCalled();
        expect(runVersionCleanup).not.toHaveBeenCalled();
        expect(f.db.downgradeStoreLease).toHaveBeenCalledOnce();
        expect(f.db.isMaintenanceActive()).toBe(false);
        if (kind === "changed") expect(current.close).toHaveBeenCalledOnce();
      } finally {
        await f.db.close();
      }
    },
  );
  it("does not reopen or prune when cancelled while old native handles close", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.connection.close.mockImplementation(() => abort.abort());
    const window = vi.fn();
    try {
      await expect(
        f.db.cleanupVersions(
          { python: "fixture", script: "prune.py" },
          abort.signal,
          window,
        ),
      ).rejects.toThrow();
      expect(f.d.openExistingTableUnsafe).toHaveBeenCalledOnce();
      expect(window).not.toHaveBeenCalled();
      expect(runVersionCleanup).not.toHaveBeenCalled();
      expect(f.db.downgradeStoreLease).toHaveBeenCalledOnce();
    } finally {
      await f.db.close();
    }
  });
  it.each(["completed", "failed"])(
    "reopens the real native connection across %s pruning without changing the table",
    async (outcome) => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "gmax-prune-native-reader-")),
      );
      roots.push(root);
      // No host sampling or helper process belongs in this native lifecycle test.
      vi.spyOn(resourceBudget, "reserve").mockImplementation(
        () => ({ release: vi.fn() }) as any,
      );
      const db = new VectorDB(root, 4);
      try {
        const initial = await db.ensureTable();
        const version = await initial.version();
        initial.close();
        const read = async () => {
          const table = await db.existingTableForRead();
          try {
            expect(await table.countRows()).toBe(0);
            expect(await table.version()).toBe(version);
          } finally {
            table.close();
          }
        };
        const window = vi.fn();
        vi.mocked(runVersionCleanup).mockImplementation(async () => {
          expect(window).toHaveBeenCalledOnce();
          await read();
          if (outcome === "failed") throw new Error("fixture prune failed");
          return {
            status: "completed",
            at: 1,
            attempts: 1,
            elapsedMs: 1,
            rewritten: false,
            versionsRemoved: 0,
            eligibleVersionsRemaining: 0,
          };
        });
        const cleanup = db.cleanupVersions(
          { python: "fixture", script: "prune.py" },
          undefined,
          window,
        );
        if (outcome === "failed")
          await expect(cleanup).rejects.toThrow("fixture prune failed");
        else await cleanup;
        // No ordinary ensureTable/search is allowed to repair the state first.
        const getDb = vi.spyOn(db as any, "getDb");
        const ensure = vi.spyOn(db, "ensureTable");
        await read();
        expect(getDb).not.toHaveBeenCalled();
        expect(ensure).not.toHaveBeenCalled();
      } finally {
        await db.close({ requireClosed: true });
      }
    },
  );
});
