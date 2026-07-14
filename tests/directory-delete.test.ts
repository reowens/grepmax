import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as watcher from "@parcel/watcher";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectBatchProcessor } from "../src/lib/index/batch-processor";

// Deleting a directory must remove the chunks + meta of every file it
// contained. Live cleanup depends on @parcel/watcher emitting a *per-file*
// `delete` for each contained file (not just one event for the directory),
// because the processor keys deletions by exact file path. This file guards
// both halves of that chain: the platform behavior, and the gmax wiring that
// turns it into deletePaths/metaCache.delete calls.

describe("recursive directory deletion", () => {
  let root: string;

  beforeEach(() => {
    // realpath so paths match what @parcel/watcher reports: on macOS
    // os.tmpdir() is /var/folders/... but the watcher emits the canonical
    // /private/var/folders/... and we compare event paths by exact string.
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "gmax-dirdel-")),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Platform canary: if a @parcel/watcher upgrade ever changed recursive
  // directory removal to report only the directory path, this fails — flagging
  // that live cleanup would silently start orphaning chunks until next catchup.
  it("@parcel/watcher emits a per-file delete for each contained file", async () => {
    const sub = path.join(root, "sub");
    const nested = path.join(sub, "deep");
    fs.mkdirSync(nested, { recursive: true });
    const fileA = path.join(sub, "a.ts");
    const fileB = path.join(nested, "b.ts");
    fs.writeFileSync(fileA, "export const a = 1;\n");
    fs.writeFileSync(fileB, "export const b = 2;\n");

    const deleted = new Set<string>();
    const sub$ = await watcher.subscribe(root, (err, events) => {
      if (err) return;
      for (const e of events) {
        if (e.type === "delete") deleted.add(e.path);
      }
    });

    try {
      // Let the watcher's initial snapshot settle before mutating.
      await new Promise((r) => setTimeout(r, 600));
      fs.rmSync(sub, { recursive: true, force: true });

      await vi.waitFor(
        () => {
          expect(deleted.has(fileA)).toBe(true);
          expect(deleted.has(fileB)).toBe(true);
        },
        { timeout: 8000, interval: 100 },
      );
    } finally {
      await sub$.unsubscribe();
    }
  }, 15000);

  // Wiring: the processor must drop the directory-level delete events (no
  // indexable extension) and route the per-file unlinks to a single
  // deletePaths call covering every contained file, plus a metaCache.delete
  // for each — and never attempt to delete the directory paths themselves.
  it("processor deletes every contained file's chunks and ignores the directory paths", async () => {
    const sub = path.join(root, "sub");
    const nested = path.join(sub, "deep");
    const fileA = path.join(sub, "a.ts");
    const fileB = path.join(nested, "b.ts");

    const deletedPaths: string[][] = [];
    const metaDeleted: string[] = [];
    const vectorDb = {
      diskPressure: "ok",
      checkDiskPressure: vi.fn(() => "ok"),
      insertBatch: vi.fn(async () => {}),
      deletePaths: vi.fn(async (paths: string[]) => {
        deletedPaths.push(paths);
      }),
      deletePathsExcludingIds: vi.fn(async () => {}),
      compactIfNeeded: vi.fn(async () => {}),
    } as any;
    const metaCache = {
      get: vi.fn(() => undefined),
      put: vi.fn(),
      delete: vi.fn((p: string) => metaDeleted.push(p)),
    } as any;

    const processor = new ProjectBatchProcessor({
      projectRoot: root,
      vectorDb,
      metaCache,
    });

    try {
      // The exact event stream a recursive rm produces: per-file deletes for the
      // contained source files, plus directory-level deletes for sub/ and deep/.
      processor.handleFileEvent("unlink", fileA);
      processor.handleFileEvent("unlink", fileB);
      processor.handleFileEvent("unlink", sub);
      processor.handleFileEvent("unlink", nested);

      // Directory events carry no indexable extension and are dropped; only the
      // two real files survive into the pending batch.
      expect(processor.progress.pendingFiles).toBe(2);

      (processor as any).startBatch();

      await vi.waitFor(() =>
        expect(vectorDb.deletePaths).toHaveBeenCalledTimes(1),
      );
    } finally {
      await processor.close();
    }

    const purged = deletedPaths.flat();
    expect(purged).toEqual(expect.arrayContaining([fileA, fileB]));
    expect(purged).not.toContain(sub);
    expect(purged).not.toContain(nested);

    expect(metaDeleted).toEqual(expect.arrayContaining([fileA, fileB]));
    expect(metaDeleted).not.toContain(sub);
    expect(metaDeleted).not.toContain(nested);

    // Pure unlinks: nothing re-embedded, so the insert path stays untouched.
    expect(vectorDb.insertBatch).not.toHaveBeenCalled();
    expect(vectorDb.deletePathsExcludingIds).not.toHaveBeenCalled();
  });
});
