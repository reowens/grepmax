import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SubscribeCallback } from "@parcel/watcher";
import * as watcher from "@parcel/watcher";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatcherManager } from "../src/lib/daemon/watcher-manager";
import { startWatcher } from "../src/lib/index/watcher";
import { computeContentHash } from "../src/lib/utils/file-utils";
import { getWorkerPool } from "../src/lib/workers/pool";

vi.mock("@parcel/watcher", () => ({ subscribe: vi.fn() }));
vi.mock("../src/lib/utils/watcher-store", () => ({
  registerWatcher: vi.fn(),
  unregisterWatcherByRoot: vi.fn(),
}));
vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: vi.fn(),
  registerProject: vi.fn(),
}));

const gap = new Error(
  "Events were dropped by the FSEvents client. File system must be re-scanned.",
);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(mode: "daemon" | "standalone") {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-recovery-state-"));
  cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }));
  const absolute = (name: string) => path.join(root, name);
  const write = (name: string, content: string) =>
    fs.writeFileSync(absolute(name), content);
  fs.mkdirSync(absolute("artifacts"));
  write(".gmaxignore", "/artifacts/\n");
  write("changed.ts", "export const changed = 1;\n");
  write("removed.ts", "export const removed = 1;\n");
  write("atomic.ts", "export const atomic = 1;\n");
  const metadata = new Map<string, any>();
  const rows = new Map<string, any>();
  const meta = {
    getKeysWithPrefix: vi.fn(async () => new Set(metadata.keys())),
    get: vi.fn((p: string) => metadata.get(p)),
    put: vi.fn((p: string, value: unknown) => metadata.set(p, value)),
    delete: vi.fn((p: string) => metadata.delete(p)),
  };
  const db = {
    diskPressure: "ok",
    checkDiskPressure: vi.fn(() => "ok"),
    getDistinctPathsForPrefix: vi.fn(
      async () => new Set([...rows.values()].map((r) => r.path)),
    ),
    getReusableEmbeddings: vi.fn(async () => new Map()),
    insertBatch: vi.fn(async (records: any[]) => {
      for (const record of records) rows.set(record.id, record);
    }),
    deletePaths: vi.fn(async (paths: string[]) => {
      for (const [id, row] of rows)
        if (paths.includes(row.path)) rows.delete(id);
    }),
    deletePathsExcludingIds: vi.fn(async (paths: string[], keep: string[]) => {
      for (const [id, row] of rows)
        if (paths.includes(row.path) && !keep.includes(id)) rows.delete(id);
    }),
    compactIfNeeded: vi.fn(async () => {}),
  };
  const pool = getWorkerPool() as any;
  pool.isHealthy = vi.fn(() => true);
  pool.processFile.mockImplementation(
    async ({ path: file }: { path: string }) => {
      const bytes = fs.readFileSync(file),
        stat = fs.statSync(file),
        hash = computeContentHash(bytes, file);
      return {
        hash,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        vectors: [
          {
            id: `${file}:${hash}`,
            path: file,
            hash,
            content: bytes.toString(),
          },
        ],
      };
    },
  );
  let notify!: SubscribeCallback;
  vi.mocked(watcher.subscribe)
    .mockClear()
    .mockImplementation(async (_root, callback) => {
      notify = callback;
      return { unsubscribe: vi.fn(async () => {}) };
    });
  let refuse = false;
  const dependencies = {
    processors: new Map(),
    subscriptions: new Map(),
    getVectorDb: () => db,
    getMetaCache: () => meta,
    getWorkerPool: () => pool,
    getShuttingDown: () => false,
    touchActivity: vi.fn(),
    evictSearcher: vi.fn(),
    runProjectOperation: async (
      _root: string,
      name: string,
      signal: AbortSignal | undefined,
      fn: (signal: AbortSignal) => Promise<any>,
    ) => {
      if (refuse && name === "watch-catchup")
        throw new Error("fixture admission refused");
      return fn(signal ?? new AbortController().signal);
    },
  };
  let health: () => any;
  let close: () => Promise<void>;
  if (mode === "daemon") {
    const manager = new WatcherManager(dependencies as any);
    await manager.watchProject(root);
    health = () => ({
      ...dependencies.processors.get(root)?.progress,
      ...manager.health(root),
    });
    close = () => manager.unwatchProject(root);
  } else {
    const handle = await startWatcher({
      projectRoot: root,
      dataDir: absolute(".gmax"),
      metaCache: meta as any,
      vectorDb: db as any,
    });
    health = () => handle.health;
    close = () => handle.close();
  }
  cleanups.push(close);
  const drain = async () =>
    vi.waitFor(
      () => {
        const state = health();
        expect(state.catchupRunning).toBe(false);
        expect(state.pendingFiles).toBe(0);
        expect(state.queue.activeFiles).toBe(0);
        expect(state.failedFiles).toBe(0);
      },
      { timeout: 10_000 },
    );
  await vi.waitFor(
    () => {
      expect(health().watcherRecovery.lastCompleteScan).toBeDefined();
      expect(rows.size).toBe(3);
    },
    { timeout: 10_000 },
  );
  await drain();
  const verify = (names: string[]) => {
    expect(
      [...rows.values()].map((r) => path.relative(root, r.path)).sort(),
    ).toEqual([...names].sort());
    expect(
      [...metadata.keys()].map((p) => path.relative(root, p)).sort(),
    ).toEqual([...names].sort());
    for (const name of names) {
      const p = absolute(name),
        bytes = fs.readFileSync(p),
        hash = computeContentHash(bytes, p);
      const row = [...rows.values()].find((r) => r.path === p);
      expect(row.content).toBe(bytes.toString());
      expect(row.hash).toBe(hash);
      expect(metadata.get(p)).toMatchObject({
        hash,
        size: bytes.length,
        hashVersion: 1,
        hasVectors: true,
      });
    }
  };
  return {
    root,
    absolute,
    write,
    meta,
    metadata,
    health,
    drain,
    advance: async (ms: number) => {
      // Let the real filesystem promises settle between fake-clock ticks.
      // Jumping five minutes at once would manufacture batch deadlines.
      for (let remaining = ms; remaining > 0; remaining -= 1_000) {
        await vi.advanceTimersByTimeAsync(Math.min(1_000, remaining));
        await fs.promises.stat(root);
      }
    },
    verify,
    setRefuse: (value: boolean) => {
      refuse = value;
    },
    notify: (error: Error | null, events: any[] = []) => notify(error, events),
  };
}

describe.each(["daemon", "standalone"] as const)(
  "%s recovery final-state qualification",
  (mode) => {
    it.each(["gap", "terminal"])(
      "converges dropped creates/deletes/atomic saves after a %s error",
      async (kind) => {
        const f = await fixture(mode);
        f.write("changed.ts", "export const changed = 200;\n");
        f.write("created.ts", "export const created = 300;\n");
        fs.unlinkSync(f.absolute("removed.ts"));
        f.write(".!123!atomic.ts", "export const atomic = 400;\n");
        fs.renameSync(f.absolute(".!123!atomic.ts"), f.absolute("atomic.ts"));
        f.write("artifacts/generated.ts", "export const ignored = 1;\n");
        if (kind === "gap") for (let i = 0; i < 20; i++) f.notify(gap);
        else f.notify(new Error("native backend stopped"));
        if (kind === "terminal") {
          await f.advance(3_000);
          await vi.waitFor(() =>
            expect(watcher.subscribe).toHaveBeenCalledTimes(2),
          );
        }
        await f.advance(kind === "gap" ? 30_000 : 300_000);
        await vi.waitFor(() =>
          expect(f.health().watcherRecovery).toMatchObject({
            outstandingGapCount: 0,
            reconciliationNeeded: false,
            lastCompleteScan: {
              terminalErrorCountAtStart: kind === "gap" ? 0 : 1,
            },
          }),
        );
        await f.drain();
        f.verify(["changed.ts", "created.ts", "atomic.ts"]);
        expect(f.health().watcherRecovery).toMatchObject({
          gapCount: kind === "gap" ? 20 : 0,
          terminalErrorCount: kind === "gap" ? 0 : 1,
          outstandingGapCount: 0,
          reconciliationNeeded: false,
        });
        expect(watcher.subscribe).toHaveBeenCalledTimes(kind === "gap" ? 1 : 2);
      },
      20_000,
    );

    it("covers a late gap with a later scan and commits its current content", async () => {
      const f = await fixture(mode);
      let late = true;
      f.meta.get.mockImplementation((p: string) => {
        const entry = f.metadata.get(p);
        if (late && p === f.absolute("changed.ts")) {
          late = false;
          f.write("changed.ts", "export const changed = 99999;\n");
          f.notify(gap);
        }
        return entry;
      });
      f.notify(gap);
      await f.advance(30_000);
      await vi.waitFor(() =>
        expect(f.health().watcherRecovery).toMatchObject({
          gapCount: 2,
          coveredGapCount: 1,
          outstandingGapCount: 1,
          lastCompleteScan: { gapCountAtStart: 1 },
        }),
      );
      await f.advance(30_000);
      await f.drain();
      expect(f.health().watcherRecovery).toMatchObject({
        coveredGapCount: 2,
        outstandingGapCount: 0,
      });
      f.verify(["changed.ts", "removed.ts", "atomic.ts"]);
    });
  },
);

it("retains dropped edits through refused recovery, then converges after admission returns", async () => {
  const f = await fixture("daemon");
  f.write("changed.ts", "export const changed = 999;\n");
  f.setRefuse(true);
  f.notify(gap);
  await f.advance(30_000);
  await vi.waitFor(() =>
    expect(f.health().watcherRecovery.lastAttemptFailure).toMatchObject({
      scanStarted: false,
    }),
  );
  expect(f.health().watcherRecovery).toMatchObject({
    outstandingGapCount: 1,
    reconciliationNeeded: true,
  });
  f.setRefuse(false);
  f.notify(gap);
  await f.advance(30_000);
  await f.drain();
  f.verify(["changed.ts", "removed.ts", "atomic.ts"]);
  expect(f.health().watcherRecovery.outstandingGapCount).toBe(0);
});
