import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ftsRefresh } from "../src/commands/fts-refresh";
import {
  ftsRefreshStatePath,
  readFtsRefreshState,
  refreshFtsStore,
  runFtsRefresh,
} from "../src/lib/store/fts-refresh";
import { runCleanupProcess } from "../src/lib/store/lance-cleanup";
import { StoreLease, storeLeasePaths } from "../src/lib/store/store-lease";

vi.mock("../src/lib/store/lance-cleanup", () => ({
  prepareCleanupRuntime: vi.fn(),
  runCleanupProcess: vi.fn(),
}));
vi.mock("../src/lib/utils/autostart", () => ({
  autostartDisabledReason: () => null,
}));
vi.mock("../src/lib/utils/safety-latch", () => ({
  safetyStopReason: () => null,
}));

describe("explicit FTS catch-up guards", () => {
  let root: string, store: string, table: string;
  let lease: StoreLease | undefined;
  const runtime = {
    python: "private-python",
    script: "/private/helper/prune.py",
  };
  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-fts-unit-"));
    store = path.join(root, "store");
    table = path.join(store, "chunks.lance");
    fs.mkdirSync(table, { recursive: true });
    vi.mocked(runCleanupProcess).mockImplementation(
      async (_exe, _args, options) => {
        options!.admission!.approve();
        return JSON.stringify({
          engine: "13.0.0",
          index: "content_idx",
          outcome: "completed",
          beforeVersion: 5,
          afterVersion: 6,
          dataRewritten: false,
          rows: 10,
          unindexedRows: 4,
          physicalInputRows: 4,
          contentBytes: 40,
          pendingFragments: 1,
          segmentsBefore: 1,
          remainingRows: 0,
          newFileBytes: 100,
          elapsedMs: 1,
          beforeFingerprint: "a".repeat(64),
        });
      },
    );
  });
  afterEach(async () => {
    await lease?.release();
    lease = undefined;
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("status reads only the durable receipt and creates no lease/runtime", async () => {
    expect(await refreshFtsStore({ table })).toMatchObject({
      outcome: "status",
      state: null,
    });
    expect(runCleanupProcess).not.toHaveBeenCalled();
    expect(fs.existsSync(`${store}.lease`)).toBe(false);
  });
  it("CLI accepts the explicit expected version without consuming package --version", () => {
    const parsed = ftsRefresh.parseOptions([
      "--table",
      table,
      "--run",
      "--expected-version",
      "5",
    ]);
    expect(parsed.unknown).toEqual([]);
    expect(ftsRefresh.opts()).toMatchObject({
      expectedVersion: 5,
      run: true,
      table,
    });
  });
  it("requires a table version and rejects ambiguous actions before setup", async () => {
    await expect(refreshFtsStore({ table, run: true })).rejects.toThrow(
      "--expected-version",
    );
    await expect(
      refreshFtsStore({ table, run: true, check: true, expectedVersion: 5 }),
    ).rejects.toThrow("either");
    expect(runCleanupProcess).not.toHaveBeenCalled();
  });
  it("refuses a table symlink", async () => {
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    const link = path.join(other, "chunks.lance");
    fs.symlinkSync(table, link);
    await expect(refreshFtsStore({ table: link })).rejects.toThrow(
      "local chunks.lance",
    );
  });
  it("does not follow a receipt symlink", () => {
    const file = path.join(root, "foreign");
    fs.writeFileSync(file, "{}");
    fs.symlinkSync(file, ftsRefreshStatePath(store));
    expect(() => readFtsRefreshState(store)).toThrow("unverified");
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
  });
  it.each(["safety-stop.json", "autostart-disabled"])(
    "preserves target containment marker %s",
    async (name) => {
      const marker = path.join(root, name);
      fs.writeFileSync(marker, "retained");
      await expect(
        refreshFtsStore({ table, run: true, expectedVersion: 5 }),
      ).rejects.toThrow("quarantined");
      expect(fs.readFileSync(marker, "utf8")).toBe("retained");
      expect(runCleanupProcess).not.toHaveBeenCalled();
    },
  );
  it("requires a real exclusive token and refuses shared owners", async () => {
    lease = await StoreLease.acquireShared({ storeDir: store });
    await expect(
      runFtsRefresh(runtime, table, lease, {
        table,
        run: true,
        expectedVersion: 5,
      }),
    ).rejects.toThrow("exclusive");
    expect(runCleanupProcess).not.toHaveBeenCalled();
  });
  it("syncs running state before write approval and records verified completion", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    const defaultRun = vi.mocked(runCleanupProcess).getMockImplementation()!;
    vi.mocked(runCleanupProcess).mockImplementation(async (...args) => {
      expect(readFtsRefreshState(store)).toBe(null);
      const result = await defaultRun(...args);
      expect(readFtsRefreshState(store)?.outcome).toBe("uncertain");
      return result;
    });
    await runFtsRefresh(runtime, table, lease, {
      table,
      run: true,
      expectedVersion: 5,
    });
    expect(readFtsRefreshState(store)).toMatchObject({
      outcome: "completed",
      result: { afterVersion: 6 },
    });
    expect(fs.statSync(ftsRefreshStatePath(store)).mode & 0o777).toBe(0o600);
  });
  it("retains uncertainty and requires exact acknowledgement before another write", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    vi.mocked(runCleanupProcess).mockImplementation(
      async (_exe, _args, options) => {
        options!.admission!.approve();
        throw new Error("fixture interruption");
      },
    );
    await expect(
      runFtsRefresh(runtime, table, lease, {
        table,
        run: true,
        expectedVersion: 5,
      }),
    ).rejects.toThrow("interruption");
    const state = readFtsRefreshState(store)!;
    expect(state.outcome).toBe("uncertain");
    await expect(
      runFtsRefresh(runtime, table, lease, {
        table,
        run: true,
        expectedVersion: 5,
      }),
    ).rejects.toThrow(state.attemptId);
    expect(runCleanupProcess).toHaveBeenCalledOnce();
  });
  it("retains a completed partial batch receipt without treating remaining rows as failure", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    const defaultRun = vi.mocked(runCleanupProcess).getMockImplementation()!;
    vi.mocked(runCleanupProcess).mockImplementation(async (...args) => {
      const result = JSON.parse(await defaultRun(...args));
      return JSON.stringify({
        ...result,
        rows: 150_000,
        unindexedRows: 120_000,
        batchRows: 80_000,
        physicalInputRows: 98_000,
        contentBytes: 40_000,
        pendingFragments: 30,
        selectedFragments: 20,
        remainingRows: 40_000,
      });
    });
    await runFtsRefresh(runtime, table, lease, {
      table,
      run: true,
      expectedVersion: 5,
    });
    expect(readFtsRefreshState(store)).toMatchObject({
      outcome: "completed",
      result: { batchRows: 80_000, remainingRows: 40_000, afterVersion: 6 },
    });
  });
  it("rejects a partial batch whose remaining-row count does not reconcile", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    const defaultRun = vi.mocked(runCleanupProcess).getMockImplementation()!;
    vi.mocked(runCleanupProcess).mockImplementation(async (...args) => {
      const result = JSON.parse(await defaultRun(...args));
      return JSON.stringify({
        ...result,
        batchRows: 2,
        selectedFragments: 1,
        pendingFragments: 2,
        remainingRows: 0,
      });
    });
    await expect(
      runFtsRefresh(runtime, table, lease, {
        table,
        run: true,
        expectedVersion: 5,
      }),
    ).rejects.toThrow();
    expect(readFtsRefreshState(store)?.outcome).toBe("uncertain");
  });
  it("retains uncertainty when final ownership verification fails after native success", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    const ownerFile = storeLeasePaths(store).intentOwnerFile;
    const originalOwner = fs.readFileSync(ownerFile);
    const withExclusiveUse = lease.withExclusiveUse.bind(lease);
    vi.spyOn(lease, "withExclusiveUse").mockImplementation(
      (directory, operation) =>
        withExclusiveUse(directory, async () => {
          const result = await operation();
          // Change ownership only after the callback has consumed a successful
          // native result. The real post-callback StoreLease check must reject.
          const owner = JSON.parse(originalOwner.toString("utf8"));
          fs.writeFileSync(
            ownerFile,
            JSON.stringify({ ...owner, nonce: randomUUID() }),
          );
          return result;
        }),
    );
    try {
      await expect(
        runFtsRefresh(runtime, table, lease, {
          table,
          run: true,
          expectedVersion: 5,
        }),
      ).rejects.toThrow("ownership could not be verified");
      expect(readFtsRefreshState(store)?.outcome).toBe("uncertain");
      expect(runCleanupProcess).toHaveBeenCalledOnce();
    } finally {
      fs.writeFileSync(ownerFile, originalOwner);
    }
    const uncertain = readFtsRefreshState(store)!;
    await expect(
      runFtsRefresh(runtime, table, lease, {
        table,
        run: true,
        expectedVersion: 5,
      }),
    ).rejects.toThrow(uncertain.attemptId);
    expect(runCleanupProcess).toHaveBeenCalledOnce();
  });
  it("invalid native completion cannot become a successful receipt", async () => {
    lease = await StoreLease.acquireExclusive({ storeDir: store });
    vi.mocked(runCleanupProcess).mockImplementation(
      async (_exe, _args, options) => {
        options!.admission!.approve();
        return '{"dataRewritten":true}';
      },
    );
    await expect(
      runFtsRefresh(runtime, table, lease, {
        table,
        run: true,
        expectedVersion: 5,
      }),
    ).rejects.toThrow("Invalid FTS");
    expect(readFtsRefreshState(store)?.outcome).toBe("uncertain");
  });
  it("a retained running receipt is uncertainty, including after parent loss", () => {
    fs.writeFileSync(
      ftsRefreshStatePath(store),
      JSON.stringify({
        schemaVersion: 1,
        storeIdentity: fs.realpathSync(store),
        attemptId: randomUUID(),
        expectedVersion: 5,
        startedAt: Date.now(),
        outcome: "running",
      }),
    );
    expect(readFtsRefreshState(store)?.outcome).toBe("uncertain");
  });
});
