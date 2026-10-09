import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoundedMaintenance } from "../src/lib/store/bounded-maintenance";
import { VectorDB } from "../src/lib/store/vector-db";

vi.mock("../src/lib/store/bounded-maintenance", () => ({
  runBoundedMaintenance: vi.fn(),
}));
vi.mock("../src/lib/store/maintenance-policy", async (original) => ({
  ...(await original<typeof import("../src/lib/store/maintenance-policy")>()),
  assertStoreMutationAllowed: () => {},
  storeMutationDeniedReason: () => null,
}));

describe("VectorDB head-changing maintenance handles", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  });
  function fixture() {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "gmax-bounded-handles-"),
    );
    roots.push(root);
    const db = new VectorDB(root, 4);
    const d = db as any;
    vi.spyOn(db, "upgradeStoreLease").mockResolvedValue({} as any);
    vi.spyOn(db, "downgradeStoreLease").mockResolvedValue({} as any);
    const table = { version: async () => 7, close: vi.fn() };
    vi.spyOn(d, "openExistingTableUnsafe").mockResolvedValue(table);
    vi.spyOn(d, "validateSchema").mockResolvedValue(undefined);
    const old = { close: vi.fn() };
    d.db = old;
    return { db, d, old, table };
  }

  it("automatically checks recovery before a new copy under the same exclusive lease", async () => {
    const f = fixture();
    vi.mocked(runBoundedMaintenance)
      .mockResolvedValueOnce({
        status: "skipped",
        recoveryPending: false,
      } as any)
      .mockResolvedValueOnce({
        status: "completed",
        aborted: false,
        remainingDeletedRows: 0,
      } as any);
    await f.db.cleanupDeletedRows(
      { executable: "fixture" },
      { open: vi.fn(), drain: vi.fn(async () => {}) },
      undefined,
      "auto",
    );
    expect(
      vi.mocked(runBoundedMaintenance).mock.calls.map((call) => call[6]),
    ).toEqual(["recover", "run"]);
    expect(f.db.upgradeStoreLease).toHaveBeenCalledOnce();
    expect(f.db.downgradeStoreLease).toHaveBeenCalledOnce();
    expect(f.db.boundedMaintenanceStatus()).toMatchObject({
      remainingDeletedRows: 0,
      aborted: false,
    });
    await f.db.close();
  });

  it("ends an automatic invocation after safe abort recovery without starting another copy", async () => {
    const f = fixture();
    vi.mocked(runBoundedMaintenance).mockResolvedValueOnce({
      status: "completed",
      aborted: true,
      remainingDeletedRows: 64,
    } as any);
    await expect(
      f.db.cleanupDeletedRows(
        { executable: "fixture" },
        { open: vi.fn(), drain: vi.fn(async () => {}) },
        undefined,
        "auto",
      ),
    ).resolves.toMatchObject({ aborted: true, remainingDeletedRows: 64 });
    expect(runBoundedMaintenance).toHaveBeenCalledOnce();
    expect(vi.mocked(runBoundedMaintenance).mock.calls[0][6]).toBe("recover");
    await f.db.close();
  });

  it("never starts a fresh copy after uncertain recovery or a skipped result without no-pending proof", async () => {
    const f = fixture();
    vi.mocked(runBoundedMaintenance).mockRejectedValueOnce(
      new Error("owned recovery cannot be proven"),
    );
    await expect(
      f.db.cleanupDeletedRows(
        { executable: "fixture" },
        { open: vi.fn(), drain: vi.fn(async () => {}) },
        undefined,
        "auto",
      ),
    ).rejects.toThrow("cannot be proven");
    expect(runBoundedMaintenance).toHaveBeenCalledOnce();
    vi.mocked(runBoundedMaintenance)
      .mockClear()
      .mockResolvedValueOnce({ status: "skipped" } as any);
    await f.db.cleanupDeletedRows(
      { executable: "fixture" },
      { open: vi.fn(), drain: vi.fn(async () => {}) },
      undefined,
      "auto",
    );
    expect(runBoundedMaintenance).toHaveBeenCalledOnce();
    await f.db.close();
  });

  it("closes before handles before protection and reopened handles after all tagged readers drain", async () => {
    const f = fixture();
    const newHandles = { close: vi.fn() };
    const events: string[] = [];
    const write = vi.fn(async () => {});
    vi.mocked(runBoundedMaintenance).mockImplementation(
      async (_store, _lease, version, _runtime, readers) => {
        expect(version).toBe(7);
        expect(f.old.close).toHaveBeenCalledOnce();
        await readers.open({
          beforeVersion: 7,
          protectedVersion: 7,
          planId: "a".repeat(64),
          receiptId: "attempt-1",
          readerTag: "gmax-before-1",
        });
        f.d.db = newHandles;
        await expect(f.db.ensureTable()).resolves.toBe(f.table);
        await expect(f.d.withWriteGate(write)).rejects.toThrow("writes paused");
        await readers.drain();
        expect(events).toEqual(["open", "drain"]);
        expect(newHandles.close).toHaveBeenCalledOnce();
        return { status: "completed" } as any;
      },
    );
    await f.db.cleanupDeletedRows(
      { executable: "fixture" },
      {
        open: () => {
          events.push("open");
        },
        drain: async () => {
          expect(newHandles.close).not.toHaveBeenCalled();
          events.push("drain");
        },
      },
    );
    expect(write).not.toHaveBeenCalled();
    expect(f.db.downgradeStoreLease).toHaveBeenCalledOnce();
    expect(f.db.isMaintenanceActive()).toBe(false);
    await f.db.close();
  });

  it("drains reopened readers after child interruption and never invokes another copy", async () => {
    const f = fixture();
    const opened = { close: vi.fn() };
    vi.mocked(runBoundedMaintenance).mockImplementation(
      async (_store, _lease, _version, _runtime, readers) => {
        await readers.open({
          beforeVersion: 7,
          protectedVersion: 7,
          planId: "a".repeat(64),
          receiptId: "attempt-1",
          readerTag: "gmax-before-1",
        });
        f.d.db = opened;
        throw new Error("interrupted; durable tags retained");
      },
    );
    const drain = vi.fn(async () => {
      expect(opened.close).not.toHaveBeenCalled();
    });
    await expect(
      f.db.cleanupDeletedRows(
        { executable: "fixture" },
        { open: vi.fn(), drain },
      ),
    ).rejects.toThrow("durable tags retained");
    expect(drain).toHaveBeenCalledOnce();
    expect(opened.close).toHaveBeenCalledOnce();
    expect(runBoundedMaintenance).toHaveBeenCalledOnce();
    expect(f.db.downgradeStoreLease).toHaveBeenCalledOnce();
    await f.db.close();
  });

  it("pins newly opened reads to the native protected current head during recovery", async () => {
    const f = fixture();
    // Exercise the actual handle-opening methods after the mocked initial
    // before-head discovery; the ordinary table head has already advanced.
    const opened = { checkout: vi.fn(async () => {}), close: vi.fn() };
    const connection = { openTable: vi.fn(async () => opened), close: vi.fn() };
    const openExisting = (VectorDB.prototype as any).openExistingTableUnsafe;
    vi.mocked(f.d.openExistingTableUnsafe)
      .mockImplementationOnce(async () => f.table)
      .mockImplementationOnce(async () => {
        f.d.openExistingTableUnsafe.mockRestore();
        vi.spyOn(f.d, "getDb").mockResolvedValue(connection);
        f.d.db = connection;
        return await openExisting.call(f.d);
      });
    vi.mocked(runBoundedMaintenance).mockImplementation(
      async (_store, _lease, _version, _runtime, readers) => {
        await readers.open({
          beforeVersion: 6,
          protectedVersion: 7,
          planId: "a".repeat(64),
          receiptId: "attempt-1",
          readerTag: "gmax-current-1",
        });
        expect(connection.openTable).toHaveBeenCalledOnce();
        expect(opened.checkout).toHaveBeenCalledWith(7);
        expect(await f.db.ensureTable()).toBe(opened);
        expect(await f.db.existingTableForRead()).toBe(opened);
        expect(opened.checkout.mock.calls).toEqual([[7], [7], [7]]);
        await readers.drain();
        expect(f.d.boundedProtectedVersion).toBeNull();
        return { status: "completed", rewritten: false } as any;
      },
    );
    await f.db.cleanupDeletedRows(
      { executable: "fixture" },
      { open: vi.fn(), drain: vi.fn(async () => {}) },
      undefined,
      "recover",
    );
    expect(connection.close).toHaveBeenCalledOnce();
    await f.db.close();
  });
});
