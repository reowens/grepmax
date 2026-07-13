import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreLease, storeLeasePaths } from "../src/lib/store/store-lease";
import { VectorDB } from "../src/lib/store/vector-db";

describe("VectorDB exclusive table mutation", () => {
  let root: string;
  let storeDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-vector-exclusive-"));
    storeDir = path.join(root, "lancedb");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("announces intent, drains writes, and blocks later writes", async () => {
    let finishWrite!: () => void;
    const activeWrite = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const conn = {
      dropTable: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const db = new VectorDB(storeDir, 384);
    (db as any).db = conn;

    const firstWrite = (db as any).withWriteGate(() => activeWrite);
    const drop = db.drop();
    await vi.waitFor(() => {
      expect(fs.existsSync(storeLeasePaths(storeDir).intentDir)).toBe(true);
    });

    const lateWrite = vi.fn(async () => {});
    const late = (db as any).withWriteGate(lateWrite);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(conn.dropTable).not.toHaveBeenCalled();
    expect(lateWrite).not.toHaveBeenCalled();

    finishWrite();
    await firstWrite;
    await drop;
    await late;
    expect(conn.dropTable).toHaveBeenCalledWith("chunks");
    expect(lateWrite).toHaveBeenCalledOnce();
    await db.close();
  });

  it.each([
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
    Object.assign(new Error("input/output error"), { code: "EIO" }),
    new Error("Not found: broken-fragment.lance"),
    new Error("uncertain drop failure"),
  ])("propagates destructive mutation failure: %s", async (failure) => {
    const conn = {
      dropTable: vi.fn(async () => {
        throw failure;
      }),
      close: vi.fn(async () => {}),
    };
    const db = new VectorDB(storeDir, 384);
    (db as any).db = conn;
    await expect(db.drop()).rejects.toBe(failure);
    await db.close();
  });

  it("ignores only a verified missing chunks table", async () => {
    const conn = {
      dropTable: vi.fn(async () => {
        throw new Error("Table 'chunks' does not exist");
      }),
      close: vi.fn(async () => {}),
    };
    const db = new VectorDB(storeDir, 384);
    (db as any).db = conn;
    await expect(db.drop()).resolves.toBeUndefined();
    await db.close();
  });

  it("can close without releasing a supplied lease", async () => {
    const lease = await StoreLease.acquireShared({
      storeDir,
      nonce: "transferred",
      processStart: "test-process",
    });
    const db = new VectorDB(storeDir, 384, lease);
    await (db as any).getLease();
    await db.close({ releaseLease: false });

    const marker = path.join(
      storeLeasePaths(storeDir).readersDir,
      "transferred.json",
    );
    expect(fs.existsSync(marker)).toBe(true);
    await lease.release();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("reuses a supplied exclusive token without releasing it", async () => {
    const exclusive = await StoreLease.acquireExclusive({
      storeDir,
      nonce: "caller-exclusive",
      processStart: "test-process",
    });
    const paths = storeLeasePaths(storeDir);
    const conn = {
      dropTable: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const db = new VectorDB(storeDir, 384, exclusive);
    (db as any).db = conn;

    await db.drop();
    expect(conn.dropTable).toHaveBeenCalledWith("chunks");
    expect(fs.existsSync(paths.intentDir)).toBe(true);

    await db.close({ releaseLease: false });
    expect(fs.existsSync(paths.intentDir)).toBe(true);
    await exclusive.release();
  });

  it("transfers an upgraded token across close and a new VectorDB", async () => {
    const source = new VectorDB(storeDir, 384);
    const exclusive = await source.upgradeStoreLease();
    expect(exclusive.mode).toBe("exclusive");
    await source.close({ releaseLease: false });
    expect(fs.existsSync(storeLeasePaths(storeDir).intentDir)).toBe(true);

    const conn = {
      dropTable: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const target = new VectorDB(storeDir, 384, exclusive);
    (target as any).db = conn;
    await target.drop();
    expect(conn.dropTable).toHaveBeenCalledOnce();
    expect(fs.existsSync(storeLeasePaths(storeDir).intentDir)).toBe(true);

    await target.close();
    expect(fs.existsSync(storeLeasePaths(storeDir).intentDir)).toBe(false);
  });

  it("downgrades a transferred token and updates the internal lease", async () => {
    const exclusive = await StoreLease.acquireExclusive({
      storeDir,
      nonce: "transferred-exclusive",
      processStart: "test-process",
    });
    const db = new VectorDB(storeDir, 384, exclusive);
    const shared = await db.downgradeStoreLease();
    const paths = storeLeasePaths(storeDir);
    const marker = path.join(paths.readersDir, `${shared.owner.nonce}.json`);

    expect(shared.mode).toBe("shared");
    expect(fs.existsSync(paths.intentDir)).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);

    await db.close();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not release a retained supplied token in a getDb-close race", async () => {
    const exclusive = await StoreLease.acquireExclusive({
      storeDir,
      nonce: "racing-exclusive",
      processStart: "test-process",
    });
    const db = new VectorDB(storeDir, 384, exclusive);
    (db as any).db = { close: vi.fn(async () => {}) };

    const getDb = (db as any).getDb();
    await db.close({ releaseLease: false });
    await expect(getDb).rejects.toThrow("VectorDB connection is closed");
    expect(fs.existsSync(storeLeasePaths(storeDir).intentDir)).toBe(true);
    await exclusive.release();
  });

  it("close waits for an exclusive mutation", async () => {
    let finishMutation!: () => void;
    const mutationBody = new Promise<void>((resolve) => {
      finishMutation = resolve;
    });
    const conn = { close: vi.fn(async () => {}) };
    const db = new VectorDB(storeDir, 384);
    (db as any).db = conn;

    const mutation = db.withExclusiveTableMutation(async () => mutationBody);
    await vi.waitFor(() => {
      expect(fs.existsSync(storeLeasePaths(storeDir).intentDir)).toBe(true);
    });
    let closed = false;
    const close = db.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    expect(conn.close).not.toHaveBeenCalled();

    finishMutation();
    await mutation;
    await close;
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it("close waits for active writes", async () => {
    let finishWrite!: () => void;
    const writeBody = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const conn = { close: vi.fn(async () => {}) };
    const db = new VectorDB(storeDir, 384);
    (db as any).db = conn;
    const write = (db as any).withWriteGate(() => writeBody);

    let closed = false;
    const close = db.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);

    finishWrite();
    await write;
    await close;
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it("wakes compaction and mutation drain waiters without deadlock", async () => {
    let finishWrite!: () => void;
    const activeWrite = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const table = {
      optimize: vi.fn(async () => ({
        compaction: { fragmentsRemoved: 0, fragmentsAdded: 0 },
        prune: { oldVersionsRemoved: 0, bytesRemoved: 0 },
      })),
      schema: vi.fn(async () => ({ fields: [] })),
    };
    const conn = {
      openTable: vi.fn(async () => table),
      dropTable: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const db = new VectorDB(storeDir, 384);
    (db as any).db = conn;
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(table as any);
    const write = (db as any).withWriteGate(() => activeWrite);
    const optimize = db.optimize();
    await vi.waitFor(() => expect((db as any).activeCompactions).toBe(1));
    const drop = db.drop();

    finishWrite();
    await write;
    await Promise.race([
      Promise.all([optimize, drop]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("drain deadlock")), 1_000),
      ),
    ]);

    expect(table.optimize).toHaveBeenCalledOnce();
    expect(conn.dropTable).toHaveBeenCalledOnce();
    await db.close();
  });

  it("runMaintenance never waits in a write gate while counted as maintenance", async () => {
    let finishFts!: () => void;
    const ftsBody = new Promise<void>((resolve) => {
      finishFts = resolve;
    });
    const table = {
      stats: vi.fn(async () => ({ totalBytes: 1 })),
    };
    const conn = {
      dropTable: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const db = new VectorDB(storeDir, 384);
    (db as any).db = conn;
    vi.spyOn(db, "createFTSIndex").mockImplementation(() =>
      (db as any).withWriteGate(() => ftsBody),
    );
    vi.spyOn(db, "optimize").mockResolvedValue(undefined);
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(table as any);

    const maintenance = db.runMaintenance();
    await vi.waitFor(() => expect((db as any).activeWrites).toBe(1));
    const drop = db.drop();
    await vi.waitFor(() =>
      expect(fs.existsSync(storeLeasePaths(storeDir).intentDir)).toBe(true),
    );
    expect((db as any).activeMaintenance).toBeUndefined();

    finishFts();
    await Promise.race([
      Promise.all([maintenance, drop]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("maintenance deadlock")), 1_000),
      ),
    ]);
    expect(conn.dropTable).toHaveBeenCalledOnce();
    await db.close();
  });

  it("compactIfNeeded serializes behind an exclusive mutation without joining its drain", async () => {
    let finishDrop!: () => void;
    const dropBody = new Promise<void>((resolve) => {
      finishDrop = resolve;
    });
    const table = {
      stats: vi.fn(async () => ({
        fragmentStats: { numSmallFragments: 0 },
      })),
    };
    const conn = {
      dropTable: vi.fn(() => dropBody),
      close: vi.fn(async () => {}),
    };
    const db = new VectorDB(storeDir, 384);
    (db as any).db = conn;
    vi.spyOn(db as any, "ensureTableUnsafe").mockResolvedValue(table as any);

    const drop = db.drop();
    await vi.waitFor(() => expect(conn.dropTable).toHaveBeenCalledOnce());
    const compact = db.compactIfNeeded();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((db as any).activeMaintenance).toBeUndefined();
    expect(table.stats).not.toHaveBeenCalled();

    finishDrop();
    await Promise.all([drop, compact]);
    expect(table.stats).toHaveBeenCalledOnce();
    await db.close();
  });

  it("reserves compaction before awaiting table setup", async () => {
    let finishSetup!: () => void;
    const setup = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    const table = {
      optimize: vi.fn(async () => ({
        compaction: { fragmentsRemoved: 0, fragmentsAdded: 0 },
        prune: { oldVersionsRemoved: 0, bytesRemoved: 0 },
      })),
    };
    const db = new VectorDB(storeDir, 384);
    (db as any).db = { close: vi.fn(async () => {}) };
    vi.spyOn(db as any, "ensureTableUnsafe").mockImplementation(async () => {
      await setup;
      return table;
    });

    const first = db.optimize();
    const second = db.optimize();
    finishSetup();
    await Promise.all([first, second]);

    expect(table.optimize).toHaveBeenCalledOnce();
    await db.close();
  });

  it("blocks public deletes before they obtain a table handle", async () => {
    let finishDrop!: () => void;
    const dropBody = new Promise<void>((resolve) => {
      finishDrop = resolve;
    });
    const table = { delete: vi.fn(async () => {}) };
    const conn = {
      dropTable: vi.fn(() => dropBody),
      openTable: vi.fn(async () => table),
      close: vi.fn(async () => {}),
    };
    const db = new VectorDB(storeDir, 384);
    (db as any).db = conn;
    vi.spyOn(db as any, "ensureTableUnsafe").mockImplementation(async () => {
      await conn.openTable();
      return table as any;
    });
    const drop = db.drop();
    await vi.waitFor(() => expect(conn.dropTable).toHaveBeenCalledOnce());

    const deletion = db.deletePathsWithPrefix("/project");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(conn.openTable).not.toHaveBeenCalled();

    finishDrop();
    await drop;
    await deletion;
    expect(conn.openTable).toHaveBeenCalledOnce();
    expect(table.delete).toHaveBeenCalledOnce();
    await db.close();
  });

  it("strict close retains ownership until the connection confirms closure", async () => {
    let finishClose!: () => void;
    const connectionClose = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const lease = await StoreLease.acquireExclusive({ storeDir });
    const db = new VectorDB(storeDir, 384, lease);
    (db as any).db = { close: vi.fn(() => connectionClose) };
    const closing = db.close({ releaseLease: false, requireClosed: true });
    let settled = false;
    void closing.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(fs.existsSync(storeLeasePaths(storeDir).intentDir)).toBe(true);

    finishClose();
    await closing;
    expect(fs.existsSync(storeLeasePaths(storeDir).intentDir)).toBe(true);
    await lease.release();
  });

  it("blocks exclusive mutation while public schema setup is active", async () => {
    let finishSetup!: () => void;
    const setup = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    const conn = {
      dropTable: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const db = new VectorDB(storeDir, 384);
    (db as any).db = conn;
    vi.spyOn(db as any, "ensureTableUnsafe").mockImplementation(async () => {
      await setup;
      return {};
    });
    const ensuring = db.ensureTable();
    const dropping = db.drop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(conn.dropTable).not.toHaveBeenCalled();

    finishSetup();
    await ensuring;
    await dropping;
    expect(conn.dropTable).toHaveBeenCalledOnce();
    await db.close();
  });

  it("rejects a stricter retained close after ordinary close has started", async () => {
    let finishClose!: () => void;
    const connectionClose = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const db = new VectorDB(storeDir, 384);
    (db as any).db = { close: vi.fn(() => connectionClose) };
    const ordinary = db.close();

    await expect(
      db.close({ releaseLease: false, requireClosed: true }),
    ).rejects.toThrow(/weaker ownership semantics/i);

    finishClose();
    await ordinary;
  });

  it("rejects released, wrong-store, and concurrently attached supplied leases", async () => {
    const otherStore = path.join(root, "other-store");
    const wrongStoreLease = await StoreLease.acquireExclusive({ storeDir });
    const wrongStoreDb = new VectorDB(otherStore, 384, wrongStoreLease);
    await expect((wrongStoreDb as any).getLease()).rejects.toThrow(
      /different store/i,
    );
    await wrongStoreDb.close();
    await wrongStoreLease.release();

    const released = await StoreLease.acquireExclusive({ storeDir });
    await released.release();
    const releasedDb = new VectorDB(storeDir, 384, released);
    await expect((releasedDb as any).getLease()).rejects.toThrow(/released/i);
    await releasedDb.close();

    const shared = await StoreLease.acquireShared({ storeDir });
    const first = new VectorDB(storeDir, 384, shared);
    const second = new VectorDB(storeDir, 384, shared);
    await (first as any).getLease();
    await expect((second as any).getLease()).rejects.toThrow(/another owner/i);
    await second.close();
    await first.close({ releaseLease: false, requireClosed: true });
    await shared.release();
  });
});
