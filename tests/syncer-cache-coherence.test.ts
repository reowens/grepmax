import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_META_HASH_VERSION } from "../src/lib/index/cache-coherence";
import { resolveEmbeddingGeneration } from "../src/lib/index/embedding-generation";
import { initialSync } from "../src/lib/index/syncer";
import type { MetaEntry } from "../src/lib/store/meta-cache";
import { computeContentHash } from "../src/lib/utils/file-utils";

const roots: string[] = [];
const generation = resolveEmbeddingGeneration({ modelTier: "small" });

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-coherence-"));
  roots.push(root);
  return root;
}

function metadata(entries: Map<string, MetaEntry>) {
  return {
    get: (file: string) => entries.get(file),
    getKeysWithPrefix: async (prefix: string) =>
      new Set([...entries.keys()].filter((file) => file.startsWith(prefix))),
    put: (file: string, entry: MetaEntry) => entries.set(file, entry),
    delete: (file: string) => entries.delete(file),
    close: async () => {},
  };
}

function vectorDb(vectorPaths: Set<string>) {
  return {
    getDistinctPathsForPrefix: vi.fn(async () => new Set(vectorPaths)),
    insertBatch: vi.fn(async () => {}),
    deletePathsExcludingIds: vi.fn(async () => {}),
    deletePaths: vi.fn(async () => {}),
    runMaintenance: vi.fn(async () => {}),
  };
}

function workerPool(result?: Record<string, unknown>) {
  return {
    generation,
    processFile: vi.fn(async () => result),
  };
}

function currentEntry(file: string, hasVectors: boolean): MetaEntry {
  const stat = fs.statSync(file);
  return {
    hash: computeContentHash(fs.readFileSync(file), file),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hashVersion: CURRENT_META_HASH_VERSION,
    hasVectors,
  };
}

describe("initialSync per-path cache coherence", () => {
  it("preserves an intentional vectorless cache entry", async () => {
    const root = createRoot();
    const file = path.join(root, "empty-result.ts");
    fs.writeFileSync(file, "export type Marker = never;\n");
    const entries = new Map([[file, currentEntry(file, false)]]);
    const db = vectorDb(new Set());
    const pool = workerPool();

    await initialSync({
      projectRoot: root,
      vectorDb: db as any,
      metaCache: metadata(entries) as any,
      workerPool: pool as any,
      generation,
      embedMode: "cpu",
    });

    expect(pool.processFile).not.toHaveBeenCalled();
    expect(entries.get(file)?.hasVectors).toBe(false);
  });

  it("reprocesses one expected vector path even when aggregate coherence would exceed 80%", async () => {
    const root = createRoot();
    const files = Array.from({ length: 10 }, (_, index) => {
      const file = path.join(root, `source-${index}.ts`);
      fs.writeFileSync(file, `export const value${index} = ${index};\n`);
      return file;
    });
    const missing = files[9];
    const entries = new Map(
      files.map((file) => [file, currentEntry(file, true)] as const),
    );
    const db = vectorDb(new Set(files.slice(0, 9)));
    const stat = fs.statSync(missing);
    const pool = workerPool({
      hash: entries.get(missing)?.hash,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      vectors: [{ id: "replacement", path: missing }],
    });

    await initialSync({
      projectRoot: root,
      vectorDb: db as any,
      metaCache: metadata(entries) as any,
      workerPool: pool as any,
      generation,
      embedMode: "cpu",
    });

    expect(pool.processFile).toHaveBeenCalledOnce();
    expect(db.insertBatch).toHaveBeenCalledOnce();
    expect(db.deletePathsExcludingIds).toHaveBeenCalledWith(
      [missing],
      ["replacement"],
    );
  });

  it("removes a vector-only orphan even when other metadata exists", async () => {
    const root = createRoot();
    const file = path.join(root, "source.ts");
    const orphan = path.join(root, "deleted.ts");
    fs.writeFileSync(file, "export const source = 1;\n");
    const entries = new Map([[file, currentEntry(file, true)]]);
    const db = vectorDb(new Set([file, orphan]));
    const pool = workerPool();

    await initialSync({
      projectRoot: root,
      vectorDb: db as any,
      metaCache: metadata(entries) as any,
      workerPool: pool as any,
      generation,
      embedMode: "cpu",
    });

    expect(pool.processFile).not.toHaveBeenCalled();
    expect(db.deletePaths).toHaveBeenCalledWith([orphan]);
  });

  it("migrates a legacy Markdown hash through the worker", async () => {
    const root = createRoot();
    const file = path.join(root, "README.md");
    const content = Buffer.from("---\nstatus: draft\n---\n# Title\n");
    fs.writeFileSync(file, content);
    const stat = fs.statSync(file);
    const entries = new Map<string, MetaEntry>([
      [
        file,
        { hash: "legacy-normalized", mtimeMs: stat.mtimeMs, size: stat.size },
      ],
    ]);
    const db = vectorDb(new Set([file]));
    const pool = workerPool({
      hash: computeContentHash(content, file),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      vectors: [{ id: "markdown", path: file }],
    });

    await initialSync({
      projectRoot: root,
      vectorDb: db as any,
      metaCache: metadata(entries) as any,
      workerPool: pool as any,
      generation,
      embedMode: "cpu",
    });

    expect(pool.processFile).toHaveBeenCalledOnce();
    expect(entries.get(file)).toMatchObject({
      hashVersion: CURRENT_META_HASH_VERSION,
      hasVectors: true,
    });
  });
});
