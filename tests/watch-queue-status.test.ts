import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatWatchQueue } from "../src/lib/output/index-state-footer";
import { MCP_READ_OUTPUT_SCHEMAS } from "../src/lib/output/mcp-results";

describe("watch queue wire diagnostics", () => {
  const schema = z
    .object(MCP_READ_OUTPUT_SCHEMAS.index_status)
    .pick({ watcher: true });
  const parseWatcher = (watcher: unknown) => schema.parse({ watcher }).watcher;
  const validWatcher = (watcher: unknown) => schema.safeParse({ watcher });
  const queue = {
    live: 2,
    catchup: 1000,
    cleanup: 5000,
    activeFiles: 1,
    oldestLiveEditAgeMs: 1250,
  };
  it("preserves additive queue diagnostics through MCP schema validation", () => {
    const result = parseWatcher({
      status: "syncing",
      indexState: { indexing: true, pendingFiles: 6002, queue },
    }) as any;
    expect(result.indexState.queue).toEqual(queue);
    expect(formatWatchQueue(result.indexState.queue)).toBe(
      "live=2 catchup=1000 cleanup=5000 active=1 oldestLiveEdit=2s",
    );
  });
  it("accepts older daemon health without queue fields", () => {
    expect(
      validWatcher({
        status: "watching",
        indexState: { indexing: false, pendingFiles: 0 },
      }).success,
    ).toBe(true);
  });
  it("rejects negative queue counts and age while allowing an idle null age", () => {
    expect(
      validWatcher({
        status: "syncing",
        indexState: {
          indexing: true,
          pendingFiles: 1,
          queue: { ...queue, live: -1 },
        },
      }).success,
    ).toBe(false);
    expect(
      validWatcher({
        status: "syncing",
        indexState: {
          indexing: true,
          pendingFiles: 1,
          queue: { ...queue, oldestLiveEditAgeMs: -1 },
        },
      }).success,
    ).toBe(false);
    expect(
      formatWatchQueue({
        live: 0,
        catchup: 0,
        cleanup: 0,
        activeFiles: 0,
        oldestLiveEditAgeMs: null,
      }),
    ).toContain("oldestLiveEdit=none");
  });
});
