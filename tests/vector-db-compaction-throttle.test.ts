import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";

const MIN_INTERVAL_MS = 30 * 60 * 1000;
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;
const START = new Date("2026-08-17T00:00:00Z");

/**
 * Regression cover for the compaction rate limiter.
 *
 * Before it existed, both opportunistic callers re-compacted whenever writes kept
 * arriving, so a 16 GB store took 43 full-table rewrites in two days (~550 GB of
 * writes) and exhausted a macOS kernel zone. See
 * docs/2026-08-04-macos-kernel-zone-panic-incident.md.
 */
describe("VectorDB compaction throttle", () => {
  let root: string;
  let db: VectorDB;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-compaction-throttle-"));
    db = new VectorDB(path.join(root, "lancedb"), 384);
    vi.spyOn(db, "createVectorIndex").mockResolvedValue(false);
    vi.spyOn(db, "createFTSIndex").mockResolvedValue(undefined);
    vi.spyOn(db as any, "openExistingTableUnsafe").mockResolvedValue({
      version: vi.fn(async () => 1),
      stats: vi.fn(async () => ({ totalBytes: 1024 })),
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Mock optimize, reporting whether each pass reclaimed anything. */
  function stubOptimize(didWork: boolean) {
    return vi.spyOn(db, "optimize").mockImplementation(async () => {
      (db as any).lastOptimizeDidWork = didWork;
    });
  }

  function advance(ms: number): void {
    vi.setSystemTime(new Date(Date.now() + ms));
  }

  it("allows the first compaction on a fresh instance", async () => {
    const optimize = stubOptimize(false);

    await db.runMaintenance();

    expect(optimize).toHaveBeenCalledOnce();
  });

  it("throttles a second maintenance pass inside the interval", async () => {
    const optimize = stubOptimize(true);

    await db.runMaintenance();
    expect(optimize).toHaveBeenCalledOnce();

    // Five minutes later — the real maintenance tick cadence.
    advance(5 * 60 * 1000);
    await db.runMaintenance();
    await db.runMaintenance();

    expect(optimize).toHaveBeenCalledOnce();
  });

  it("compacts again once the interval elapses", async () => {
    const optimize = stubOptimize(true);

    await db.runMaintenance();
    advance(MIN_INTERVAL_MS);
    await db.runMaintenance();

    expect(optimize).toHaveBeenCalledTimes(2);
  });

  it("still indexes while compaction is throttled", async () => {
    stubOptimize(true);
    await db.runMaintenance();

    const fts = db.createFTSIndex as ReturnType<typeof vi.spyOn>;
    fts.mockClear();
    advance(60 * 1000);
    await db.runMaintenance();

    // FTS/vector index creation is idempotent and cheap to re-attempt; only the
    // whole-table rewrite is rate-limited.
    expect(fts).toHaveBeenCalledOnce();
  });

  it("lets a forced caller bypass the throttle", async () => {
    const optimize = stubOptimize(true);

    await db.runMaintenance();
    advance(60 * 1000);
    await db.runMaintenance({ force: true });

    expect(optimize).toHaveBeenCalledTimes(2);
  });

  it("doubles the interval when a compaction reclaims nothing", async () => {
    stubOptimize(false);

    await db.runMaintenance();
    expect(db.getCompactionThrottleState().intervalMs).toBe(
      MIN_INTERVAL_MS * 2,
    );

    advance(MIN_INTERVAL_MS * 2);
    await db.runMaintenance();
    expect(db.getCompactionThrottleState().intervalMs).toBe(
      MIN_INTERVAL_MS * 4,
    );
  });

  it("caps the backoff at the ceiling", async () => {
    stubOptimize(false);

    for (let i = 0; i < 12; i++) {
      await db.runMaintenance({ force: true });
    }

    expect(db.getCompactionThrottleState().intervalMs).toBe(MAX_INTERVAL_MS);
  });

  it("resets to the floor after a productive compaction", async () => {
    const optimize = stubOptimize(false);

    await db.runMaintenance();
    await db.runMaintenance({ force: true });
    expect(db.getCompactionThrottleState().intervalMs).toBeGreaterThan(
      MIN_INTERVAL_MS,
    );

    optimize.mockImplementation(async () => {
      (db as any).lastOptimizeDidWork = true;
    });
    await db.runMaintenance({ force: true });

    expect(db.getCompactionThrottleState().intervalMs).toBe(MIN_INTERVAL_MS);
  });

  it("keeps the floor when only the bloat retry comes up empty", async () => {
    // First pass reclaims, the bloat retry does not. The store is still
    // improvable, so this must not read as an unproductive cycle.
    let call = 0;
    vi.spyOn(db, "optimize").mockImplementation(async () => {
      (db as any).lastOptimizeDidWork = call++ === 0;
    });
    vi.spyOn(db as any, "getDirectorySize").mockReturnValue(1024 * 10);

    // The bloat retry sleeps 2s between passes; drive it under fake timers.
    const pending = db.runMaintenance();
    await vi.advanceTimersByTimeAsync(3000);
    await pending;

    expect(call).toBe(2);
    expect(db.getCompactionThrottleState().intervalMs).toBe(MIN_INTERVAL_MS);
  });

  it("throttles compactIfNeeded past the fragment threshold", async () => {
    const optimize = stubOptimize(true);
    vi.spyOn(db as any, "checkDiskPressure").mockReturnValue("ok");
    vi.spyOn(db, "ensureTable").mockResolvedValue({
      stats: async () => ({ fragmentStats: { numSmallFragments: 9999 } }),
    } as any);

    expect(await db.compactIfNeeded(10)).toBe(true);
    expect(optimize).toHaveBeenCalledOnce();

    advance(60 * 1000);
    expect(await db.compactIfNeeded(10)).toBe(false);
    expect(optimize).toHaveBeenCalledOnce();

    advance(MIN_INTERVAL_MS);
    expect(await db.compactIfNeeded(10)).toBe(true);
    expect(optimize).toHaveBeenCalledTimes(2);
  });

  it("shares the limiter between both opportunistic callers", async () => {
    const optimize = stubOptimize(true);
    vi.spyOn(db as any, "checkDiskPressure").mockReturnValue("ok");
    vi.spyOn(db, "ensureTable").mockResolvedValue({
      stats: async () => ({ fragmentStats: { numSmallFragments: 9999 } }),
    } as any);

    await db.runMaintenance();
    advance(60 * 1000);

    // A fragment trip must not sneak past the floor the maintenance pass set.
    expect(await db.compactIfNeeded(10)).toBe(false);
    expect(optimize).toHaveBeenCalledOnce();
  });

  it("does not wedge shut if the clock jumps backwards", async () => {
    const optimize = stubOptimize(true);

    await db.runMaintenance();
    advance(-24 * 60 * 60 * 1000);
    await db.runMaintenance();

    expect(optimize).toHaveBeenCalledTimes(2);
  });
});
