import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRecoveryCutoff } from "../src/commands/recover";
import { readPruneState, writePruneState } from "../src/lib/store/prune-state";
import { recoverStore } from "../src/lib/store/recovery";
import { StoreLease } from "../src/lib/store/store-lease";

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  prepare: vi.fn(),
  prune: vi.fn(),
  release: vi.fn(),
  reserve: vi.fn(),
}));
vi.mock("../src/lib/store/recovery-admission", () => ({
  assertRecoveryAdmission: mocks.admit,
  createRecoveryBudget: () => ({ reserve: mocks.reserve }),
  admitPrune: () => ({ close: mocks.release }),
}));
vi.mock("../src/lib/store/lance-cleanup", () => ({
  prepareCleanupRuntime: mocks.prepare,
  pruneVersions: mocks.prune,
}));

vi.unmock("../src/lib/utils/resource-budget");

describe("explicit recovery orchestration", () => {
  it("rejects ambiguous and normalized invalid calendar cutoffs", () => {
    expect(() => parseRecoveryCutoff("2026-02-30T00:00:00Z")).toThrow(
      "calendar",
    );
    expect(() => parseRecoveryCutoff("2026-10-07")).toThrow("timezone");
    expect(
      parseRecoveryCutoff("2026-10-07T01:02:03.123-07:00").toISOString(),
    ).toBe("2026-10-07T08:02:03.123Z");
  });
  let root: string, store: string, table: string;
  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-recovery-"));
    store = path.join(root, "lancedb");
    table = path.join(store, "chunks.lance");
    fs.mkdirSync(table, { recursive: true });
    mocks.reserve.mockReturnValue({ release: mocks.release });
    mocks.admit.mockImplementation(() => {});
    mocks.prepare.mockResolvedValue({ python: "fixture", script: "fixture" });
    mocks.prune.mockResolvedValue({
      allocatedBytesBefore: 100,
      allocatedBytesAfter: 40,
      freeBytesBefore: 500,
      freeBytesAfter: 480,
    });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it("status loads only the durable receipt, never admission or runtime", async () => {
    const report = await recoverStore({ table });
    expect(report.outcome).toBe("status");
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(fs.existsSync(`${store}.lease`)).toBe(false);
  });
  it("check does not prepare, acquire exclusion or prune", async () => {
    expect((await recoverStore({ table, check: true })).outcome).toBe(
      "preflight-passed",
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.prune).not.toHaveBeenCalled();
    expect(fs.existsSync(`${store}.lease`)).toBe(false);
  });
  it("requires explicit valid version/cutoff before setup", async () => {
    await expect(recoverStore({ table, prune: true })).rejects.toThrow(
      "--version",
    );
    await expect(
      recoverStore({
        table,
        prune: true,
        version: 1,
        cutoff: new Date(Date.now() + 10000),
      }),
    ).rejects.toThrow("nonfuture");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("refuses recovery admission without calling setup or deletion", async () => {
    mocks.admit.mockImplementation(() => {
      throw new Error("unknown host");
    });
    await expect(
      recoverStore({ table, prune: true, version: 1, cutoff: new Date() }),
    ).rejects.toThrow("unknown host");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.prune).not.toHaveBeenCalled();
  });
  it("requires an exact acknowledgement of an uncertain prior attempt", async () => {
    writePruneState({
      schemaVersion: 1,
      storeIdentity: fs.realpathSync(store),
      attemptId: "interrupted",
      version: 1,
      cutoffMs: 0,
      startedAt: 0,
      outcome: "running",
    });
    await expect(
      recoverStore({ table, prune: true, version: 1, cutoff: new Date() }),
    ).rejects.toThrow("--acknowledge-uncertain interrupted");
    expect(readPruneState(store)?.outcome).toBe("uncertain");
    expect(mocks.prepare).not.toHaveBeenCalled();
    await recoverStore({
      table,
      prune: true,
      version: 1,
      cutoff: new Date(),
      acknowledgeUncertain: "interrupted",
    });
    expect(mocks.prune).toHaveBeenCalledOnce();
  });
  it("holds exclusion during pruning and reports signed recovery separately", async () => {
    mocks.prune.mockImplementation(async () => {
      const keep = setInterval(() => {}, 1000);
      try {
        await expect(
          StoreLease.acquireShared({ storeDir: store, timeoutMs: 20 }),
        ).rejects.toThrow("Timed out");
      } finally {
        clearInterval(keep);
      }
      return {
        allocatedBytesBefore: 100,
        allocatedBytesAfter: 40,
        freeBytesBefore: 500,
        freeBytesAfter: 480,
      };
    });
    const report = await recoverStore({
      table,
      prune: true,
      version: 1,
      cutoff: new Date(),
    });
    expect(report).toMatchObject({
      outcome: "verified",
      allocatedBytesRecovered: 60,
      filesystemFreeBytesChange: -20,
    });
    expect(mocks.release).toHaveBeenCalled();
    const lease = await StoreLease.acquireShared({ storeDir: store });
    await lease.release();
  });
  it("refuses live store owners without stopping them", async () => {
    const owner = await StoreLease.acquireShared({ storeDir: store });
    const keep = setInterval(() => {}, 1000);
    try {
      await expect(
        recoverStore({ table, prune: true, version: 1, cutoff: new Date() }),
      ).rejects.toThrow("close them separately");
      expect(mocks.prune).not.toHaveBeenCalled();
    } finally {
      clearInterval(keep);
      await owner.release();
    }
  });
});
