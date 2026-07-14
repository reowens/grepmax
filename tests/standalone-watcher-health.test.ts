import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@parcel/watcher", () => ({
  subscribe: vi.fn(async () => ({ unsubscribe: vi.fn(async () => {}) })),
}));

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
