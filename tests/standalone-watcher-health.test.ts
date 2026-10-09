import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@parcel/watcher", () => ({
  subscribe: vi.fn(async () => ({ unsubscribe: vi.fn(async () => {}) })),
}));

import * as watcher from "@parcel/watcher";
import { startWatcher } from "../src/lib/index/watcher";
import { getWorkerPool } from "../src/lib/workers/pool";

describe("standalone watcher health", () => {
  let root: string;
  const handles: Array<{ close: () => Promise<void> }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-standalone-health-"));
  });

  afterEach(async () => {
    await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("replaces native subscriptions when root exclusions change and preserves re-inclusions", async () => {
    vi.useRealTimers();
    const policy = path.join(root, ".gmaxignore");
    fs.writeFileSync(policy, "/artifacts/**/*.json\n");
    vi.mocked(watcher.subscribe).mockClear();
    const handle = await startWatcher({
      projectRoot: root,
      dataDir: path.join(root, ".gmax"),
      metaCache: {
        getKeysWithPrefix: vi.fn(async () => new Set<string>()),
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
      } as any,
      vectorDb: {
        diskPressure: "ok",
        checkDiskPressure: vi.fn(() => "ok"),
        getDistinctPathsForPrefix: vi.fn(async () => new Set<string>()),
        deletePaths: vi.fn(async () => {}),
      } as any,
    });
    handles.push(handle);
    expect(vi.mocked(watcher.subscribe).mock.calls[0][2]?.ignore).toContain(
      "artifacts/**/*.json",
    );
    const previous = await vi.mocked(watcher.subscribe).mock.results[0].value;
    const firstExclusions = handle.health.watcherRecovery!.exclusions!;
    expect(firstExclusions.attached).toBe(true);
    fs.writeFileSync(policy, "/artifacts/**/*.json\n!artifacts/source.json\n");
    vi.mocked(watcher.subscribe).mock.calls[0][1](null, [
      { type: "update", path: policy },
    ]);
    await vi.waitFor(() => expect(watcher.subscribe).toHaveBeenCalledTimes(2));
    expect(vi.mocked(watcher.subscribe).mock.calls[1][2]?.ignore).not.toContain(
      "artifacts/**/*.json",
    );
    expect(previous.unsubscribe).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      const next = handle.health.watcherRecovery!.exclusions!;
      expect(next.attached).toBe(true);
      expect(next.fingerprint).not.toBe(firstExclusions.fingerprint);
      expect(next.filterCount).toBeLessThan(firstExclusions.filterCount);
    });
    fs.unlinkSync(policy);
    vi.mocked(watcher.subscribe).mock.calls[1][1](null, [
      { type: "delete", path: policy },
    ]);
    await vi.waitFor(() => expect(handle.progress.pendingFiles).toBe(0));
    // Removing an already empty native policy needs no subscription churn.
    expect(watcher.subscribe).toHaveBeenCalledTimes(2);
  });

  it("reconciles FSEvents gaps without detaching and keeps live event priority", async () => {
    vi.useRealTimers();
    vi.mocked(watcher.subscribe).mockClear();
    const getKeysWithPrefix = vi.fn(async () => new Set<string>());
    const onHealthChange = vi.fn();
    const handle = await startWatcher({
      projectRoot: root,
      dataDir: path.join(root, ".gmax"),
      onHealthChange,
      metaCache: {
        getKeysWithPrefix,
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
      } as any,
      vectorDb: {
        diskPressure: "ok",
        checkDiskPressure: vi.fn(() => "ok"),
        getDistinctPathsForPrefix: vi.fn(async () => new Set<string>()),
      } as any,
    });
    handles.push(handle);
    await vi.waitFor(() =>
      expect(onHealthChange).toHaveBeenCalledWith(true, 0),
    );
    vi.useFakeTimers();
    const callback = vi.mocked(watcher.subscribe).mock.calls[0][1];
    const gap = new Error(
      "Events were dropped by the FSEvents client. File system must be re-scanned.",
    );
    const file = path.join(root, "saved.ts");
    fs.writeFileSync(file, "export const saved = 1;\n");
    callback(gap, [{ type: "update", path: file }]);
    for (let i = 0; i < 10; i++) callback(gap, []);
    expect(onHealthChange).toHaveBeenLastCalledWith(false, 1);
    expect(handle.progress.queue).toMatchObject({ live: 1, catchup: 0 });
    expect(handle.health.watcherRecovery).toMatchObject({
      gapCount: 11,
      terminalErrorCount: 0,
      coveredGapCount: 0,
      outstandingGapCount: 11,
      reconciliationNeeded: true,
      exclusions: { attached: true },
    });
    expect(handle.health.queue).toMatchObject({ live: 1 });
    expect(getKeysWithPrefix).toHaveBeenCalledOnce();
    const sub = await vi.mocked(watcher.subscribe).mock.results[0].value;
    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(watcher.subscribe).toHaveBeenCalledOnce();
    // Closing cancels the gap timer, without waiting for it or resubscribing.
    await handle.close();
    handles.pop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getKeysWithPrefix).toHaveBeenCalledOnce();
  });

  it("keeps a later standalone gap outstanding until the next complete scan", async () => {
    vi.useRealTimers();
    vi.mocked(watcher.subscribe).mockClear();
    const getKeysWithPrefix = vi.fn(async () => new Set<string>());
    const handle = await startWatcher({
      projectRoot: root,
      dataDir: path.join(root, ".gmax"),
      metaCache: {
        getKeysWithPrefix,
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
      } as any,
      vectorDb: {
        diskPressure: "ok",
        checkDiskPressure: vi.fn(() => "ok"),
        getDistinctPathsForPrefix: vi.fn(async () => new Set<string>()),
      } as any,
    });
    handles.push(handle);
    await vi.waitFor(() =>
      expect(handle.health.watcherRecovery?.lastCompleteScan?.id).toBe(1),
    );
    const callback = vi.mocked(watcher.subscribe).mock.calls[0][1];
    const gap = new Error(
      "Events were dropped by the kernel. File system must be re-scanned.",
    );
    getKeysWithPrefix.mockImplementationOnce(async () => {
      callback(gap, []);
      return new Set<string>();
    });
    vi.useFakeTimers();
    callback(gap, []);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() =>
      expect(handle.health.watcherRecovery).toMatchObject({
        gapCount: 2,
        coveredGapCount: 1,
        outstandingGapCount: 1,
        reconciliationNeeded: true,
        lastCompleteScan: { id: 2, gapCountAtStart: 1 },
      }),
    );
    expect(handle.health.watcherMode).toBe("recovering");
    // The timer was created under fake time during the second scan.
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(handle.health.watcherRecovery).toMatchObject({
        coveredGapCount: 2,
        outstandingGapCount: 0,
        reconciliationNeeded: false,
        lastCompleteScan: { id: 3, gapCountAtStart: 2 },
      }),
    );
    expect(watcher.subscribe).toHaveBeenCalledOnce();
  });

  it("replaces a terminally failed stream and ignores its queued callbacks", async () => {
    vi.useRealTimers();
    vi.mocked(watcher.subscribe).mockClear();
    const onHealthChange = vi.fn();
    const handle = await startWatcher({
      projectRoot: root,
      dataDir: path.join(root, ".gmax"),
      onHealthChange,
      metaCache: {
        getKeysWithPrefix: vi.fn(async () => new Set<string>()),
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
      } as any,
      vectorDb: {
        diskPressure: "ok",
        checkDiskPressure: vi.fn(() => "ok"),
        getDistinctPathsForPrefix: vi.fn(async () => new Set<string>()),
      } as any,
    });
    handles.push(handle);
    await vi.waitFor(() =>
      expect(onHealthChange).toHaveBeenCalledWith(true, 0),
    );
    const oldCallback = vi.mocked(watcher.subscribe).mock.calls[0][1];
    oldCallback(new Error("backend stopped"), []);
    await vi.waitFor(() => expect(watcher.subscribe).toHaveBeenCalledTimes(2));
    const sub = await vi.mocked(watcher.subscribe).mock.results[0].value;
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    const healthCalls = onHealthChange.mock.calls.length;
    oldCallback(new Error("backend stopped"), []);
    expect(onHealthChange.mock.calls.length).toBe(healthCalls);
    expect(watcher.subscribe).toHaveBeenCalledTimes(2);
    expect(handle.health.watcherRecovery).toMatchObject({
      gapCount: 0,
      terminalErrorCount: 1,
    });
  });

  it("clears initial degradation only after queued repair work settles", async () => {
    const file = path.join(root, "source.ts");
    fs.writeFileSync(file, "export const value = 1;\n");
    const stat = fs.statSync(file);
    vi.mocked(getWorkerPool().processFile).mockResolvedValue({
      hash: "updated",
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      vectors: [],
    });
    const getKeysWithPrefix = vi.fn(async () => new Set([file]));
    const onHealthChange = vi.fn();
    const handle = await startWatcher({
      projectRoot: root,
      dataDir: path.join(root, ".gmax"),
      initialFailedFiles: 1,
      onHealthChange,
      metaCache: {
        getKeysWithPrefix,
        get: vi.fn(() => ({
          hash: "existing",
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        })),
        put: vi.fn(),
        delete: vi.fn(),
      } as any,
      vectorDb: {
        diskPressure: "ok",
        checkDiskPressure: vi.fn(() => "ok"),
        getDistinctPathsForPrefix: vi.fn(async () => new Set([file])),
        insertBatch: vi.fn(async () => {}),
        deletePaths: vi.fn(async () => {}),
        deletePathsExcludingIds: vi.fn(async () => {}),
        compactIfNeeded: vi.fn(async () => {}),
      } as any,
    });
    handles.push(handle);

    await vi.waitFor(() => expect(getKeysWithPrefix).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(handle.progress.pendingFiles).toBe(1));
    expect(handle.progress.queue).toMatchObject({
      live: 0,
      catchup: 1,
      cleanup: 0,
    });
    expect(onHealthChange).not.toHaveBeenCalledWith(true, 0);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() =>
      expect(onHealthChange).toHaveBeenCalledWith(true, 0),
    );
  });

  it("clears scan-only degradation after a complete empty reconciliation", async () => {
    const onHealthChange = vi.fn();
    const handle = await startWatcher({
      projectRoot: root,
      dataDir: path.join(root, ".gmax"),
      initialScanErrors: 1,
      onHealthChange,
      metaCache: {
        getKeysWithPrefix: vi.fn(async () => new Set<string>()),
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
      } as any,
      vectorDb: {
        diskPressure: "ok",
        checkDiskPressure: vi.fn(() => "ok"),
        getDistinctPathsForPrefix: vi.fn(async () => new Set<string>()),
        insertBatch: vi.fn(async () => {}),
        deletePaths: vi.fn(async () => {}),
        deletePathsExcludingIds: vi.fn(async () => {}),
        compactIfNeeded: vi.fn(async () => {}),
      } as any,
    });
    handles.push(handle);

    await vi.waitFor(() =>
      expect(onHealthChange).toHaveBeenCalledWith(true, 0),
    );
  });
});
