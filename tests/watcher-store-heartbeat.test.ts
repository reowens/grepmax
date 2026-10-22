import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexState } from "../src/lib/output/index-state-footer";

const db = vi.hoisted(() => ({
  getRange: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("lmdb", () => ({ open: vi.fn(() => db) }));
vi.mock("node:fs", () => ({ mkdirSync: vi.fn() }));

import { heartbeat, listWatchers } from "../src/lib/utils/watcher-store";

describe("standalone watcher diagnostic heartbeat", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("startup inspection retains stale registry evidence without probing or pruning", () => {
    const stale = {
      pid: 910002,
      projectRoot: "/stale",
      startTime: 10,
      lastHeartbeat: 1,
    };
    db.getRange.mockReturnValue([
      { key: "/stale", value: stale },
      { key: "__daemon__", value: { pid: 910001 } },
    ]);
    const probe = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("host probe forbidden");
    });
    expect(listWatchers({ includeStale: true })).toEqual([stale]);
    expect(db.remove).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("timestamps supplied health independently of later ordinary heartbeats", () => {
    const health: IndexState = {
      indexing: true,
      pendingFiles: 1,
      queue: {
        live: 1,
        catchup: 0,
        cleanup: 0,
        activeFiles: 0,
        oldestLiveEditAgeMs: 100,
      },
    };
    const entry = {
      pid: 123,
      projectRoot: "/synthetic",
      startTime: 10,
      status: "watching",
    };
    db.getRange.mockReturnValue([{ key: entry.projectRoot, value: entry }]);
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    heartbeat(123, health);
    const written = db.put.mock.calls[0][1];
    expect(written).toMatchObject({
      indexState: health,
      indexStateAt: 1000,
      lastHeartbeat: 1000,
    });
    db.getRange.mockReturnValue([{ key: entry.projectRoot, value: written }]);
    heartbeat(123);
    expect(db.put.mock.calls[1][1]).toMatchObject({
      indexState: health,
      indexStateAt: 1000,
      lastHeartbeat: 2000,
    });
  });

  it("keeps legacy entries valid and leaves other PIDs untouched", () => {
    db.getRange.mockReturnValue([
      {
        key: "/legacy",
        value: { pid: 123, projectRoot: "/legacy", startTime: 10 },
      },
      { key: "/other", value: { pid: 999 } },
    ]);
    heartbeat(123);
    expect(db.put).toHaveBeenCalledOnce();
    expect(db.put.mock.calls[0][0]).toBe("/legacy");
    expect(db.put.mock.calls[0][1].indexState).toBeUndefined();
    expect(db.put.mock.calls[0][1].indexStateAt).toBeUndefined();
  });
});
