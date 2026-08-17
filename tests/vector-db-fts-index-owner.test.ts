import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";

// Search runs in every process (daemon, each CLI fallback, each MCP session).
// When the search path built the FTS index on a miss, N processes issued
// CreateIndex against the same table version concurrently — Lance rejected the
// losers with a retryable commit conflict and each winner wrote a full-size
// inverted index, which is how _indices reached 47GB in 35 near-identical
// copies. Building is now reserved for the index owner; everyone else adopts.
describe("VectorDB FTS index ownership", () => {
  let root: string;
  let db: VectorDB;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-fts-owner-"));
    db = new VectorDB(path.join(root, "lancedb"), 384);
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("defaults to non-owner so readers never build shared indexes", () => {
    expect(db.canBuildIndexes()).toBe(false);
  });

  it("reports ownership once marked", () => {
    db.markIndexOwner();
    expect(db.canBuildIndexes()).toBe(true);
  });

  it("adoptFTSIndex never calls createIndex when the index is missing", async () => {
    const createIndex = vi.fn();
    vi.spyOn(db, "ensureTable").mockResolvedValue({
      listIndices: async () => [],
      createIndex,
    } as any);

    await expect(db.adoptFTSIndex()).rejects.toThrow(/not built yet/);
    expect(createIndex).not.toHaveBeenCalled();
  });

  it("adoptFTSIndex succeeds without building when the index already exists", async () => {
    const createIndex = vi.fn();
    vi.spyOn(db, "ensureTable").mockResolvedValue({
      listIndices: async () => [{ name: "content_idx", columns: ["content"] }],
      createIndex,
    } as any);

    await expect(db.adoptFTSIndex()).resolves.toBeUndefined();
    expect(createIndex).not.toHaveBeenCalled();
  });

  it("matches an FTS index that covers content under a different name", async () => {
    vi.spyOn(db, "ensureTable").mockResolvedValue({
      listIndices: async () => [{ name: "legacy_fts", columns: ["content"] }],
      createIndex: vi.fn(),
    } as any);

    await expect(db.adoptFTSIndex()).resolves.toBeUndefined();
  });

  it("short-circuits once ensured, without re-listing indices", async () => {
    const listIndices = vi.fn(async () => [
      { name: "content_idx", columns: ["content"] },
    ]);
    vi.spyOn(db, "ensureTable").mockResolvedValue({
      listIndices,
      createIndex: vi.fn(),
    } as any);

    await db.adoptFTSIndex();
    await db.adoptFTSIndex();
    expect(listIndices).toHaveBeenCalledTimes(1);
  });

  it("throwing on a missing index is load-bearing: callers must see failure", async () => {
    // ftsAvailable is only meaningful if adoption failure is visible, mirroring
    // the same contract createFTSIndexUnsafe has for terminal failures.
    vi.spyOn(db, "ensureTable").mockResolvedValue({
      listIndices: async () => [{ name: "path_idx", columns: ["path"] }],
      createIndex: vi.fn(),
    } as any);

    await expect(db.adoptFTSIndex()).rejects.toThrow();
  });
});
