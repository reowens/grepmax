import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as lancedb from "../src/lib/store/lance-sdk";
import {
  assertFreshDiskMutationAllowed,
  fullTableMaintenanceDisabled,
  maintenancePolicyPath,
  recordMaintenanceContainment,
} from "../src/lib/store/maintenance-policy";
import { VectorDB } from "../src/lib/store/vector-db";
import { autostartDisabledReason } from "../src/lib/utils/autostart";
import { safetyStopReason } from "../src/lib/utils/safety-latch";

// Only host state is mocked. The shipped immutable maintenance policy is real.
vi.mock("../src/lib/utils/autostart", () => ({
  autostartDisabledReason: vi.fn(() => null),
}));
vi.mock("../src/lib/utils/safety-latch", () => ({
  safetyStopReason: vi.fn(() => null),
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, statfsSync: vi.fn(original.statfsSync) };
});
vi.mock("../src/lib/store/lance-sdk", () => ({
  connect: vi.fn(),
  Session: vi.fn(),
}));

describe("VectorDB host-safety containment", () => {
  let root: string;
  let db: VectorDB;
  beforeEach(() => {
    vi.mocked(fs.statfsSync).mockReset();
    vi.mocked(fs.statfsSync).mockReturnValue({
      type: 0,
      frsize: 4096,
      bsize: 4096,
      blocks: 100_000_000,
      bfree: 100_000_000,
      bavail: 100_000_000,
      files: 100_000,
      ffree: 100_000,
    });
    vi.mocked(autostartDisabledReason).mockReturnValue(null);
    vi.mocked(safetyStopReason).mockReturnValue(null);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-containment-"));
    db = new VectorDB(root, 4);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await db.close();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function forbidNativeWork() {
    return [
      vi.spyOn(db as any, "getDb"),
      vi.spyOn(db as any, "ensureTableUnsafe"),
      vi.spyOn(db as any, "openExistingTableUnsafe"),
      vi.spyOn(db, "createFTSIndex"),
      vi.spyOn(db, "createVectorIndex"),
      vi.spyOn(db as any, "cleanupCompactionReservation"),
    ].map((spy) =>
      spy.mockImplementation(() => {
        throw new Error("containment must refuse before native work");
      }),
    );
  }

  it("refuses every rewrite entry point, including force and positive retention", async () => {
    const spies = forbidNativeWork();
    expect(fullTableMaintenanceDisabled()).toBe(true);
    for (const result of [
      await db.optimize(),
      await db.optimize(5, 60_000, true),
      await db.runMaintenance(),
      await db.runMaintenance({ force: true }),
    ]) {
      expect(result).toMatchObject({ status: "skipped", attempts: 0 });
      expect(result?.reason).toContain("host-safety containment");
    }
    expect(await db.compactIfNeeded(0)).toBe(false);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect((db as any).maintainedEpoch).toBe(-1);
    expect((db as any).maintainedTableVersion).toBeNull();
    expect(
      JSON.parse(fs.readFileSync(maintenancePolicyPath(root), "utf8")),
    ).toMatchObject({
      mode: "disabled",
      rewriteBudgetBytes: 0,
      cleanupPending: true,
    });
    expect(fs.statSync(maintenancePolicyPath(root)).mode & 0o777).toBe(0o600);
  });

  it("continuous edits and timer boundaries cannot trigger a rewrite", async () => {
    vi.useFakeTimers();
    const spies = forbidNativeWork();
    db.startMaintenanceLoop();
    for (let tick = 0; tick < 3; tick++) {
      (db as any).writeEpoch++;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect((db as any).maintainedEpoch).toBe(-1);
    expect(db.isMaintenanceActive()).toBe(false);
  });

  it("refuses direct FTS rebuild and ANN creation before table/native work", async () => {
    const open = vi.spyOn(db as any, "openExistingTableUnsafe");
    const mutate = vi.spyOn(db as any, "ensureTableUnsafe");
    await expect(db.createFTSIndex(true, 5)).rejects.toThrow(
      "host-safety containment",
    );
    expect(await db.createVectorIndex(true, 5, false)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("adopts existing FTS read-only and never treats a missing index as ready", async () => {
    const mutate = vi.spyOn(db as any, "ensureTableUnsafe");
    const table = {
      listIndices: vi.fn(async () => [
        { name: "content_idx", columns: ["content"] },
      ]),
    };
    const open = vi
      .spyOn(db as any, "openExistingTableUnsafe")
      .mockResolvedValue(table);
    await db.createFTSIndex();
    expect((db as any).ftsIndexEnsured).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
    (db as any).ftsIndexEnsured = false;
    table.listIndices.mockResolvedValue([]);
    await expect(db.createFTSIndex()).rejects.toThrow("FTS index not built");
    expect((db as any).ftsIndexEnsured).toBe(false);
    open.mockResolvedValue(null);
    await expect(db.createFTSIndex()).rejects.toThrow("No existing table");
    expect((db as any).ftsIndexEnsured).toBe(false);
  });

  it("restart, clock changes and an enabling policy file cannot authorize rewrites", async () => {
    fs.writeFileSync(
      maintenancePolicyPath(root),
      JSON.stringify({ mode: "enabled" }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01"));
    expect((await db.optimize()).status).toBe("skipped");
    await db.close();
    db = new VectorDB(root, 4);
    const spies = forbidNativeWork();
    expect((await db.runMaintenance({ force: true }))?.status).toBe("skipped");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(
      JSON.parse(fs.readFileSync(maintenancePolicyPath(root), "utf8")).mode,
    ).toBe("disabled");
  });

  it("corrupt or symlinked policy state stays disabled without overwriting it", async () => {
    const target = maintenancePolicyPath(root);
    fs.writeFileSync(target, "corrupt");
    expect(recordMaintenanceContainment(root)).toContain("still disabled");
    expect(fs.readFileSync(target, "utf8")).toBe("corrupt");
    fs.unlinkSync(target);
    const unrelated = path.join(root, "untouched.json");
    fs.writeFileSync(unrelated, "untouched");
    fs.symlinkSync(unrelated, target);
    expect((await db.optimize()).reason).toContain("still disabled");
    expect(fs.readFileSync(unrelated, "utf8")).toBe("untouched");
  });

  it("unknown disk space suspends mutations instead of granting unlimited headroom", () => {
    vi.mocked(fs.statfsSync).mockImplementation(() => {
      throw Object.assign(new Error("unavailable"), { code: "EIO" });
    });
    expect(db.getAvailableBytes()).toBeNaN();
    expect(() => assertFreshDiskMutationAllowed(root)).toThrow(
      "writes suspended",
    );
    expect(db.checkDiskPressure()).toBe("critical");
    expect(() => (db as any).ensureDiskOk()).toThrow("writes suspended");
  });

  it.each([Number.NaN, -1, 0])(
    "refuses delete/update/exclusive mutation with fresh unsafe space %s",
    async (available) => {
      // A previous healthy cached sample must not authorize the next mutation.
      expect(db.checkDiskPressure()).toBe("ok");
      vi.spyOn(db, "getAvailableBytes").mockReturnValue(available);
      const open = vi.spyOn(db as any, "openExistingTableUnsafe");
      const create = vi.spyOn(db as any, "ensureTableUnsafe");
      const native = vi.fn();
      await expect(db.deletePaths(["/fixture/a.ts"])).rejects.toThrow(
        "writes suspended",
      );
      await expect(
        db.updateRows(["row"], "summary", ["updated"]),
      ).rejects.toThrow("writes suspended");
      await expect(db.withExclusiveTableMutation(native)).rejects.toThrow(
        "writes suspended",
      );
      expect(open).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
    },
  );

  it("checks fresh disk again after waiting for another operation", async () => {
    let release!: () => void;
    (db as any).compactingPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const available = vi
      .spyOn(db, "getAvailableBytes")
      .mockReturnValue(100 * 1024 ** 3);
    const native = vi.fn();
    const waiting = (db as any).withWriteGate(native);
    await Promise.resolve();
    available.mockReturnValue(Number.NaN);
    (db as any).compactingPromise = null;
    release();
    await expect(waiting).rejects.toThrow("writes suspended");
    expect(native).not.toHaveBeenCalled();
  });

  it("checks fresh disk again after an exclusive operation drains earlier writes", async () => {
    (db as any).activeWrites = 1;
    vi.spyOn(db as any, "getLease").mockResolvedValue({ mode: "exclusive" });
    const connection = vi.spyOn(db as any, "getDb");
    const available = vi
      .spyOn(db, "getAvailableBytes")
      .mockReturnValue(100 * 1024 ** 3);
    const native = vi.fn();
    const waiting = db.withExclusiveTableMutation(native);
    await vi.waitFor(() =>
      expect((db as any).writeDrainResolvers.size).toBe(1),
    );
    available.mockReturnValue(Number.NaN);
    (db as any).activeWrites = 0;
    for (const resolve of (db as any).writeDrainResolvers) resolve();
    (db as any).writeDrainResolvers.clear();
    await expect(waiting).rejects.toThrow("writes suspended");
    expect(connection).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    expect((db as any).exclusiveMutationPromise).toBeNull();
  });

  it("unknown filesystem reads an existing table without native mutation", async () => {
    vi.spyOn(db, "getAvailableBytes").mockReturnValue(Number.NaN);
    const existing = {};
    vi.spyOn(db as any, "openExistingTableUnsafe").mockResolvedValue(existing);
    vi.spyOn(db as any, "validateSchema").mockResolvedValue(undefined);
    const mutation = vi.spyOn(db as any, "ensureTableUnsafe");
    expect(await db.ensureTable()).toBe(existing);
    expect(mutation).not.toHaveBeenCalled();
  });

  it.each([0, Number.NaN])(
    "refuses missing-store setup before lease/connection/directory work at unsafe space %s",
    async (available) => {
      const missing = path.join(root, "missing-store");
      const another = new VectorDB(missing, 4);
      const lease = vi.spyOn(another as any, "getLease");
      vi.mocked(fs.statfsSync).mockReturnValue({
        type: 0,
        frsize: 4096,
        bsize: 1,
        blocks: available,
        bfree: available,
        bavail: available,
        files: 0,
        ffree: 0,
      });
      vi.mocked(lancedb.connect).mockClear();
      await expect(another.ensureTable()).rejects.toThrow("writes suspended");
      expect(lease).not.toHaveBeenCalled();
      expect(lancedb.connect).not.toHaveBeenCalled();
      expect(fs.existsSync(missing)).toBe(false);
      await another.close();
    },
  );

  it("rechecks fresh disk after a missing-store lease wait before directory/connection setup", async () => {
    const missing = path.join(root, "missing-after-wait");
    const another = new VectorDB(missing, 4);
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const lease = vi
      .spyOn(another as any, "getLease")
      .mockImplementation(() => wait);
    vi.mocked(lancedb.connect).mockClear();
    const opening = (another as any).getDb();
    await Promise.resolve();
    expect(lease).toHaveBeenCalledOnce();
    vi.mocked(fs.statfsSync).mockImplementation(() => {
      throw Object.assign(new Error("unavailable"), { code: "EIO" });
    });
    resume();
    await expect(opening).rejects.toThrow("writes suspended");
    expect(lancedb.connect).not.toHaveBeenCalled();
    expect(fs.existsSync(missing)).toBe(false);
    await another.close();
  });

  it("measures a new store's existing ancestor without treating permission errors as missing", () => {
    const missing = path.join(root, "new", "store");
    const another = new VectorDB(missing, 4);
    const statfs = vi.mocked(fs.statfsSync).mockImplementation(((
      directory: string,
    ) => {
      if (directory !== root)
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { bavail: 10, bsize: 4096 };
    }) as any);
    expect(another.getAvailableBytes()).toBe(40_960);
    statfs.mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    expect(another.getAvailableBytes()).toBeNaN();
    void another.close();
  });

  it.each(["env", "file", "safety"] as const)(
    "refuses mutations under %s quarantine",
    async (reason) => {
      vi.mocked(autostartDisabledReason).mockReturnValue(reason);
      const native = vi.fn();
      await expect((db as any).withWriteGate(native)).rejects.toThrow(
        "quarantined",
      );
      await expect(db.withExclusiveTableMutation(native)).rejects.toThrow(
        "quarantined",
      );
      expect(native).not.toHaveBeenCalled();
    },
  );

  it("rechecks a safety stop after waiting for an earlier operation", async () => {
    let release!: () => void;
    (db as any).compactingPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const native = vi.fn();
    const waiting = (db as any).withWriteGate(native);
    await Promise.resolve();
    vi.mocked(safetyStopReason).mockReturnValue("kernel pressure");
    (db as any).compactingPromise = null;
    release();
    await expect(waiting).rejects.toThrow("kernel pressure");
    expect(native).not.toHaveBeenCalled();
  });

  it("allows quarantined reads of an existing table without creation or schema evolution", async () => {
    vi.mocked(safetyStopReason).mockReturnValue("incident containment");
    const existing = {};
    vi.spyOn(db as any, "openExistingTableUnsafe").mockResolvedValue(existing);
    const validate = vi
      .spyOn(db as any, "validateSchema")
      .mockResolvedValue(undefined);
    const mutate = vi.spyOn(db as any, "ensureTableUnsafe");
    expect(await db.ensureTable()).toBe(existing);
    expect(validate).toHaveBeenCalledWith(existing);
    expect(mutate).not.toHaveBeenCalled();
  });
});
