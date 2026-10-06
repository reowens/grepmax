import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/lib/daemon/daemon";
import { FULL_TABLE_MAINTENANCE_DISABLED_REASON } from "../src/lib/store/maintenance-policy";
import { VectorDB } from "../src/lib/store/vector-db";

// Constructors remain inert; no startup, native store opening, models or probes.
describe("containment skips disabled background work before admission", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not schedule speculative embedding warmup or enter its operation", async () => {
    vi.useFakeTimers();
    const daemon = new Daemon();
    const operation = vi.spyOn(daemon, "runSharedOperation");
    const kernel = vi.spyOn(daemon as any, "checkKernelZonePressure");
    const embed = vi.fn();
    const table = vi.fn();
    (daemon as any).workerPool = { encodeQuery: embed };
    (daemon as any).vectorDb = { ensureTable: table };

    (daemon as any).scheduleSearchWarmup();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(operation).not.toHaveBeenCalled();
    expect(kernel).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(table).not.toHaveBeenCalled();
  });

  it("returns disabled maintenance without executing a callback or kernel admission", async () => {
    const daemon = new Daemon();
    const admission = vi.spyOn(daemon as any, "assertHeavyOperationAdmission");
    const kernel = vi.spyOn(daemon as any, "checkKernelZonePressure");
    const callback = vi.fn(async () => {
      throw new Error("disabled callback must not run");
    });

    await expect(
      daemon.runSharedOperation("store-maintenance", undefined, callback),
    ).resolves.toMatchObject({
      status: "skipped",
      attempts: 0,
      reason: FULL_TABLE_MAINTENANCE_DISABLED_REASON,
    });
    expect(callback).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(kernel).not.toHaveBeenCalled();
  });

  it("disabled maintenance still respects closed coordinator admission", async () => {
    const daemon = new Daemon();
    (daemon as any).operations.close();
    const callback = vi.fn(async () => undefined);
    await expect(
      daemon.runSharedOperation("store-maintenance", undefined, callback),
    ).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["search", "semantic-search", "watch-batch", "search-warmup"])(
    "does not bypass resource admission for %s",
    async (name) => {
      const daemon = new Daemon();
      const admission = vi
        .spyOn(daemon as any, "assertHeavyOperationAdmission")
        .mockImplementation(() => {
          throw new Error("resource admission refused");
        });
      const callback = vi.fn(async () => true);
      await expect(
        daemon.runSharedOperation(name, undefined, callback),
      ).rejects.toThrow("resource admission refused");
      expect(admission).toHaveBeenCalledWith(name);
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it("does not create a periodic maintenance timer or call its runner", async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "gmax-no-maintenance-timer-"),
    );
    const db = new VectorDB(directory, 4);
    try {
      const runner = vi.fn(async (callback: () => Promise<void>) => callback());
      const native = vi.spyOn(db as any, "getDb");
      db.startMaintenanceLoop(runner);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(runner).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
      expect(db.compactionStatus()).toMatchObject({
        status: "skipped",
        attempts: 0,
      });
      expect((db as any).maintainedEpoch).toBe(-1);
      expect(db.isMaintenanceActive()).toBe(false);
    } finally {
      await db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
