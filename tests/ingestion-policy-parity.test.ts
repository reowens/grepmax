import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/watcher-store", () => ({
  registerWatcher: vi.fn(),
  unregisterWatcherByRoot: vi.fn(),
}));

import { WatcherManager } from "../src/lib/daemon/watcher-manager";
import { ProjectBatchProcessor } from "../src/lib/index/batch-processor";
import { ProjectFilePolicy } from "../src/lib/index/file-policy";
import { walk } from "../src/lib/index/walker";
import { getWorkerPool } from "../src/lib/workers/pool";

describe("ingestion file-policy parity", () => {
  let root: string;
  let processor: ProjectBatchProcessor | null;
  let pool: any;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-policy-parity-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "fixtures"));
    fs.writeFileSync(
      path.join(root, "src", "main.ts"),
      "export const main = 1;\n",
    );
    fs.writeFileSync(
      path.join(root, "secrets.ts"),
      "export const secret = 1;\n",
    );
    fs.writeFileSync(
      path.join(root, "src", "schema.generated.ts"),
      "export const generated = 1;\n",
    );
    fs.writeFileSync(
      path.join(root, "fixtures", "sample.ts"),
      "export const fixture = 1;\n",
    );
    fs.writeFileSync(path.join(root, ".gitignore"), "src/ignored.ts\n");
    fs.writeFileSync(
      path.join(root, "src", "ignored.ts"),
      "export const ignored = 1;\n",
    );
    processor = null;
    pool = getWorkerPool() as any;
    pool.processFile.mockReset();
  });

  afterEach(async () => {
    await processor?.close();
    pool.processFile.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("indexes the same path set in full walk, catchup, and live events", async () => {
    const policy = new ProjectFilePolicy(root);
    const expected = path.join(root, "src", "main.ts");
    const candidates = [
      expected,
      path.join(root, "secrets.ts"),
      path.join(root, "src", "schema.generated.ts"),
      path.join(root, "fixtures", "sample.ts"),
      path.join(root, "src", "ignored.ts"),
    ];

    const walked: string[] = [];
    for await (const relative of walk(root, { policy })) {
      walked.push(path.join(root, relative));
    }
    expect(walked).toEqual([expected]);

    const catchupEvents: Array<[string, string]> = [];
    const metaCache = {
      get: vi.fn(),
      getKeysWithPrefix: vi.fn(async () => new Set<string>()),
      put: vi.fn(),
    };
    const manager = new WatcherManager({
      processors: new Map(),
      subscriptions: new Map(),
      getVectorDb: () => null,
      getMetaCache: () => metaCache,
      getShuttingDown: () => false,
      touchActivity: vi.fn(),
      evictSearcher: vi.fn(),
    } as any);
    const catchupProcessor = {
      filePolicy: policy,
      progress: { processing: false, pendingFiles: 0 },
      handleFileEvent: (event: string, file: string) =>
        catchupEvents.push([event, file]),
    };
    await (manager as any).catchupScan(
      root,
      catchupProcessor,
      new AbortController().signal,
    );
    expect(catchupEvents).toEqual([["change", expected]]);

    const stat = fs.statSync(expected);
    pool.processFile.mockResolvedValue({
      hash: "hash",
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      vectors: [],
    });
    const vectorDb = {
      diskPressure: "ok",
      insertBatch: vi.fn(async () => {}),
      deletePaths: vi.fn(async () => {}),
      deletePathsExcludingIds: vi.fn(async () => {}),
      compactIfNeeded: vi.fn(async () => {}),
    };
    processor = new ProjectBatchProcessor({
      projectRoot: root,
      vectorDb: vectorDb as any,
      metaCache: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } as any,
      filePolicy: policy,
    });
    for (const candidate of candidates) {
      processor.handleFileEvent("change", candidate);
    }
    (processor as any).startBatch();
    await (processor as any).activeBatch;

    expect(pool.processFile).toHaveBeenCalledTimes(1);
    expect(pool.processFile).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: expected }),
      expect.any(AbortSignal),
    );
  });
});
