import { EventEmitter } from "node:events";
import type * as net from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";
import { StoreLeaseTimeoutError } from "../src/lib/store/store-lease";

const mocks = vi.hoisted(() => ({
  readGlobalConfig: vi.fn(),
  reserve: vi.fn(),
  restore: vi.fn(),
  stamp: vi.fn(),
  markDropping: vi.fn(),
  complete: vi.fn(),
  statuses: new Map<string, "pending" | "indexed">(),
}));

vi.mock("../src/lib/index/index-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/index/index-config")>()),
  readGlobalConfig: mocks.readGlobalConfig,
}));

vi.mock("../src/lib/utils/project-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/lib/utils/project-registry")
  >()),
  reserveProjectsForRebuild: mocks.reserve,
  restoreProjectsAfterRebuild: mocks.restore,
  stampProjectFullSync: mocks.stamp,
  markProjectRebuildDropping: mocks.markDropping,
  completeProjectRebuild: mocks.complete,
  hasUnfinishedProjectRebuild: vi.fn(() => false),
  getProject: (root: string) => ({
    root,
    name: root.slice(1),
    status: mocks.statuses.get(root) ?? "pending",
  }),
}));

import { Daemon } from "../src/lib/daemon/daemon";

class FakeConnection extends EventEmitter {
  writable = true;
  writes: Array<Record<string, unknown>> = [];

  write(bytes: string): boolean {
    this.writes.push(JSON.parse(bytes.trim()));
    return true;
  }

  end(): this {
    return this;
  }
}

function makeHarness() {
  const oldGeneration = resolveEmbeddingGeneration({ modelTier: "small" });
  const targetGeneration = resolveEmbeddingGeneration({
    modelTier: "standard",
  });
  const targetConfig = {
    modelTier: "standard",
    vectorDim: targetGeneration.vectorDim,
    embedMode: "cpu" as const,
  };
  mocks.readGlobalConfig.mockReturnValue(targetConfig);
  mocks.statuses.set("/one", "pending");
  mocks.statuses.set("/two", "pending");
  const reservation = {
    rebuildId: "rebuild-1",
    previous: [],
    reserved: [
      { root: "/one", name: "one" },
      { root: "/two", name: "two" },
    ],
  };
  mocks.reserve.mockReturnValue(reservation);
  mocks.stamp.mockImplementation(({ root }: { root: string }) => {
    mocks.statuses.set(root, "indexed");
  });

  const exclusiveLease = { mode: "exclusive", release: vi.fn(async () => {}) };
  const oldDb = {
    pauseMaintenanceLoop: vi.fn(),
    resumeMaintenanceLoop: vi.fn(),
    upgradeStoreLease: vi.fn(async () => exclusiveLease),
    downgradeStoreLease: vi.fn(async () => ({ mode: "shared" })),
    close: vi.fn(async () => {}),
    startMaintenanceLoop: vi.fn(),
  };
  const oldPool = { destroy: vi.fn(async () => {}), getWorkerPids: () => [] };
  const targetDb = {
    drop: vi.fn(async () => {}),
    getSchemaVectorDim: vi.fn(async () => targetGeneration.vectorDim),
    ensureTable: vi.fn(async () => ({})),
    countRowsForPath: vi.fn(async () => 3),
    downgradeStoreLease: vi.fn(async () => ({ mode: "shared" })),
    startMaintenanceLoop: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const targetPool = {
    destroy: vi.fn(async () => {}),
    getWorkerPids: () => [],
  };
  const daemon = new Daemon() as any;
  vi.spyOn(daemon, "shutdown").mockResolvedValue(undefined);
  daemon.metaCache = {};
  daemon.ready = true;
  daemon.activeConfig = {
    modelTier: "small",
    vectorDim: oldGeneration.vectorDim,
    embedMode: "cpu",
  };
  daemon.activeGeneration = oldGeneration;
  daemon.vectorDb = oldDb;
  daemon.workerPool = oldPool;
  daemon.resources = {
    id: 1,
    config: daemon.activeConfig,
    embedding: oldGeneration,
    vectorDb: oldDb,
    workerPool: oldPool,
    mlx: "cpu",
  };
  vi.spyOn(daemon.watcherManager, "quiesceAll").mockResolvedValue([
    "/one",
    "/two",
  ]);
  vi.spyOn(daemon.watcherManager, "resumeAll").mockResolvedValue(undefined);
  vi.spyOn(daemon.watcherManager, "watchProject").mockResolvedValue(undefined);
  vi.spyOn(daemon.watcherManager, "catchupAll").mockResolvedValue(undefined);
  vi.spyOn(daemon, "watchProjectWithinOperation").mockResolvedValue(undefined);
  vi.spyOn(daemon, "createVectorDb").mockReturnValue(targetDb);
  vi.spyOn(daemon, "createWorkerPool").mockReturnValue(targetPool);
  vi.spyOn(daemon, "reindexOneProject").mockImplementation(
    async (...args: unknown[]) => ({
      processed: 1,
      indexed: 1,
      total: 1,
      failedFiles: 0,
      degraded: false,
      scanErrors: [],
      generation: targetGeneration,
      embedMode: "cpu",
      registryExpectation: {
        embeddingFingerprint: targetGeneration.fingerprint,
        rebuildId: reservation.rebuildId,
      },
      root: String(args[0]),
    }),
  );
  return {
    daemon,
    oldDb,
    oldPool,
    targetDb,
    targetPool,
    targetGeneration,
    exclusiveLease,
  };
}

describe("daemon exclusive generation rebuild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.statuses.clear();
  });

  it("publishes the verified target generation and stamps each project", async () => {
    const { daemon, oldDb, oldPool, targetDb, targetPool, targetGeneration } =
      makeHarness();
    const conn = new FakeConnection();

    await daemon.repairRebuild(conn as unknown as net.Socket);

    expect(oldPool.destroy).toHaveBeenCalledBefore(oldDb.close);
    expect(oldDb.close).toHaveBeenCalledWith({
      releaseLease: false,
      requireClosed: true,
    });
    expect(targetDb.drop).toHaveBeenCalledOnce();
    expect(mocks.markDropping).toHaveBeenCalledOnce();
    expect(targetDb.ensureTable).toHaveBeenCalledOnce();
    expect(targetDb.downgradeStoreLease).toHaveBeenCalledOnce();
    expect(daemon.workerPool).toBe(targetPool);
    expect(daemon.activeGeneration.fingerprint).toBe(
      targetGeneration.fingerprint,
    );
    expect(mocks.stamp).toHaveBeenCalledTimes(2);
    expect(mocks.complete).toHaveBeenCalledWith("rebuild-1");
    expect(conn.writes[conn.writes.length - 1]).toMatchObject({
      type: "done",
      ok: true,
      completed: 2,
      total: 2,
    });
  });

  it("resumes the old generation without teardown when lease acquisition fails", async () => {
    const { daemon, oldDb, oldPool, targetDb } = makeHarness();
    oldDb.upgradeStoreLease.mockRejectedValue(
      new StoreLeaseTimeoutError("blocked", [
        {
          pid: 42,
          processStart: "start",
          nonce: "reader",
          role: "mcp",
          acquiredAt: 1,
        },
      ]),
    );
    const conn = new FakeConnection();

    await daemon.repairRebuild(conn as unknown as net.Socket);

    expect(oldPool.destroy).not.toHaveBeenCalled();
    expect(targetDb.drop).not.toHaveBeenCalled();
    expect(oldDb.resumeMaintenanceLoop).toHaveBeenCalledOnce();
    expect(daemon.watcherManager.resumeAll).toHaveBeenCalled();
    expect(conn.writes[conn.writes.length - 1]).toMatchObject({
      ok: false,
      degraded: false,
      blockers: [expect.objectContaining({ pid: 42, role: "mcp" })],
    });
  });

  it("reconstructs old resources and restores reservations on a pre-drop failure", async () => {
    const { daemon, targetDb } = makeHarness();
    const restoredDb = {
      downgradeStoreLease: vi.fn(async () => ({})),
      startMaintenanceLoop: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const restoredPool = { destroy: vi.fn(), getWorkerPids: () => [] };
    daemon.createVectorDb
      .mockImplementationOnce(() => {
        throw new Error("target construction failed");
      })
      .mockReturnValue(restoredDb);
    daemon.createWorkerPool.mockReturnValue(restoredPool);
    const conn = new FakeConnection();

    await daemon.repairRebuild(conn as unknown as net.Socket);

    expect(targetDb.drop).not.toHaveBeenCalled();
    expect(mocks.restore).toHaveBeenCalledOnce();
    expect(daemon.workerPool).toBe(restoredPool);
    expect(restoredDb.downgradeStoreLease).toHaveBeenCalledOnce();
    expect(daemon.watcherManager.resumeAll).toHaveBeenCalledWith(
      ["/one", "/two"],
      { catchup: false },
    );
    expect(conn.writes[conn.writes.length - 1]).toMatchObject({
      ok: false,
      degraded: false,
    });
  });

  it("fails closed and cleans reconstructed resources when pool creation fails", async () => {
    const { daemon, exclusiveLease } = makeHarness();
    const restoredDb = {
      downgradeStoreLease: vi.fn(async () => ({})),
      startMaintenanceLoop: vi.fn(),
      close: vi.fn(async () => {}),
    };
    daemon.createVectorDb
      .mockImplementationOnce(() => {
        throw new Error("target construction failed");
      })
      .mockReturnValue(restoredDb);
    daemon.createWorkerPool.mockImplementation(() => {
      throw new Error("pool construction failed");
    });
    const conn = new FakeConnection();

    await daemon.repairRebuild(conn as unknown as net.Socket);

    expect(restoredDb.close).toHaveBeenCalledOnce();
    expect(exclusiveLease.release).toHaveBeenCalled();
    expect(daemon.ready).toBe(false);
    expect(daemon.resources).toBeNull();
    expect(daemon.vectorDb).toBeNull();
    expect(daemon.workerPool).toBeNull();
    expect(daemon.watcherManager.resumeAll).not.toHaveBeenCalled();
  });

  it("does not publish or restore watchers when reconstructed lease downgrade fails", async () => {
    const { daemon } = makeHarness();
    const restoredPool = {
      destroy: vi.fn(async () => {}),
      getWorkerPids: () => [],
    };
    const restoredDb = {
      downgradeStoreLease: vi.fn(async () => {
        throw new Error("downgrade failed");
      }),
      startMaintenanceLoop: vi.fn(),
      close: vi.fn(async () => {}),
    };
    daemon.createVectorDb
      .mockImplementationOnce(() => {
        throw new Error("target construction failed");
      })
      .mockReturnValue(restoredDb);
    daemon.createWorkerPool.mockReturnValue(restoredPool);
    const conn = new FakeConnection();

    await daemon.repairRebuild(conn as unknown as net.Socket);

    expect(restoredPool.destroy).toHaveBeenCalledWith({ requireExit: true });
    expect(restoredDb.close).toHaveBeenCalledOnce();
    expect(daemon.ready).toBe(false);
    expect(daemon.resources).toBeNull();
    expect(daemon.watcherManager.resumeAll).not.toHaveBeenCalled();
  });

  it("enters degraded state without restoring old identity after drop", async () => {
    const { daemon, targetDb } = makeHarness();
    targetDb.ensureTable.mockRejectedValue(new Error("create failed"));
    const conn = new FakeConnection();

    await daemon.repairRebuild(conn as unknown as net.Socket);

    expect(mocks.restore).not.toHaveBeenCalled();
    expect(daemon.ready).toBe(false);
    expect(daemon.resources).toBeNull();
    expect(daemon.vectorDb).toBe(targetDb);
    expect(targetDb.downgradeStoreLease).toHaveBeenCalledOnce();
    expect(conn.writes[conn.writes.length - 1]).toMatchObject({
      ok: false,
      degraded: true,
    });
  });

  it("continues after the client disconnects once drop commits", async () => {
    const { daemon, targetDb } = makeHarness();
    const conn = new FakeConnection();
    targetDb.drop.mockImplementation(async () => {
      conn.writable = false;
      conn.emit("close");
    });

    await daemon.repairRebuild(conn as unknown as net.Socket);

    expect(mocks.stamp).toHaveBeenCalledTimes(2);
    expect(targetDb.downgradeStoreLease).toHaveBeenCalledOnce();
    expect(daemon.ready).toBe(true);
  });

  it("restores watchers when the client disconnects during quiescence", async () => {
    const { daemon, oldPool, targetDb } = makeHarness();
    let finishQuiesce!: () => void;
    daemon.watcherManager.quiesceAll.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finishQuiesce = () => resolve(["/one", "/two"]);
        }),
    );
    const conn = new FakeConnection();
    const rebuilding = daemon.repairRebuild(conn as unknown as net.Socket);
    await vi.waitFor(() => expect(finishQuiesce).toBeTypeOf("function"));
    conn.emit("close");
    finishQuiesce();
    await rebuilding;

    expect(oldPool.destroy).not.toHaveBeenCalled();
    expect(targetDb.drop).not.toHaveBeenCalled();
    expect(daemon.watcherManager.resumeAll).toHaveBeenCalledWith(
      ["/one", "/two"],
      { catchup: false },
    );
  });

  it("downgrades exclusive ownership when cancellation follows lease upgrade", async () => {
    const { daemon, oldDb, oldPool, exclusiveLease } = makeHarness();
    const conn = new FakeConnection();
    oldDb.upgradeStoreLease.mockImplementation(async () => {
      conn.emit("close");
      return exclusiveLease;
    });

    await daemon.repairRebuild(conn as unknown as net.Socket);

    expect(oldDb.downgradeStoreLease).toHaveBeenCalledOnce();
    expect(oldPool.destroy).not.toHaveBeenCalled();
    expect(daemon.watcherManager.resumeAll).toHaveBeenCalled();
  });

  it("fails closed when cancellation lease downgrade cannot be completed", async () => {
    const { daemon, oldDb, oldPool, exclusiveLease } = makeHarness();
    const conn = new FakeConnection();
    oldDb.upgradeStoreLease.mockImplementation(async () => {
      conn.emit("close");
      return exclusiveLease;
    });
    oldDb.downgradeStoreLease.mockRejectedValue(new Error("lock collision"));

    await daemon.repairRebuild(conn as unknown as net.Socket);

    expect(oldPool.destroy).toHaveBeenCalledWith({ requireExit: true });
    expect(oldDb.close).toHaveBeenCalledOnce();
    expect(exclusiveLease.release).toHaveBeenCalledOnce();
    expect(daemon.ready).toBe(false);
    expect(daemon.resources).toBeNull();
    expect(daemon.watcherManager.resumeAll).not.toHaveBeenCalled();
  });

  it("cancels after strict old-DB close but before entering drop", async () => {
    const { daemon, oldDb, targetDb } = makeHarness();
    let finishClose!: () => void;
    oldDb.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const conn = new FakeConnection();
    const rebuilding = daemon.repairRebuild(conn as unknown as net.Socket);
    await vi.waitFor(() => expect(oldDb.close).toHaveBeenCalledOnce());
    conn.emit("close");
    finishClose();
    await rebuilding;

    expect(targetDb.drop).not.toHaveBeenCalled();
    expect(mocks.restore).toHaveBeenCalledOnce();
  });
});
