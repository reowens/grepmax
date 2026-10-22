import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISK_LOW_BYTES } from "../src/config";
import { fullTableMaintenanceDisabled } from "../src/lib/store/maintenance-policy";
import { VectorDB } from "../src/lib/store/vector-db";

// Only host state is mocked. The shipped immutable maintenance policy is real,
// so createFTSIndex can still only adopt; buildMissingFTSIndex is the one path.
vi.mock("../src/lib/utils/autostart", () => ({
  autostartDisabledReason: vi.fn(() => null),
}));
vi.mock("../src/lib/utils/safety-latch", () => ({
  safetyStopReason: vi.fn(() => null),
}));

describe("VectorDB one-time FTS build under containment", () => {
  let root: string;
  let db: VectorDB;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-fts-once-"));
    db = new VectorDB(path.join(root, "lancedb"), 384);
    vi.spyOn(db as any, "getAvailableBytes").mockReturnValue(
      DISK_LOW_BYTES * 2,
    );
  });

  afterEach(async () => {
    await db.close();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function insert(id: string, content: string): Promise<void> {
    await db.insertBatch([
      { ...(db as any).seedRow(), id, path: `/repo/${id}.ts`, content },
    ]);
  }

  async function ftsIndices() {
    const table = await (db as any).openExistingTableUnsafe();
    return (await table.listIndices()).filter((index: any) =>
      index.columns.includes("content"),
    );
  }

  async function ftsHits(term: string): Promise<string[]> {
    const table = await (db as any).openExistingTableUnsafe();
    const rows = await table.query().fullTextSearch(term).limit(10).toArray();
    return rows.map((row: { id: string }) => row.id).sort();
  }

  it("refuses a caller that is not the index owner", async () => {
    await insert("a", "alpha zebrafish");
    await expect(db.buildMissingFTSIndex()).rejects.toThrow(/index owner/);
    expect(await ftsIndices()).toHaveLength(0);
  });

  it("builds once when missing, then never rebuilds or replaces it", async () => {
    expect(fullTableMaintenanceDisabled()).toBe(true);
    db.markIndexOwner();
    await insert("a", "alpha zebrafish");
    await insert("b", "beta narwhal");

    // The ordinary owner path still only adopts under containment.
    await expect(db.createFTSIndex()).rejects.toThrow(/not built yet/);
    expect(await ftsIndices()).toHaveLength(0);

    await expect(db.buildMissingFTSIndex()).resolves.toMatchObject({
      status: "built",
    });
    const built = await ftsIndices();
    expect(built).toHaveLength(1);
    expect(await ftsHits("zebrafish")).toEqual(["a"]);

    await expect(db.buildMissingFTSIndex()).resolves.toMatchObject({
      status: "exists",
    });
    expect(await ftsIndices()).toEqual(built);

    // Rows written after the build stay searchable without rebuilding.
    await insert("c", "gamma zebrafish");
    expect(await ftsHits("zebrafish")).toEqual(["a", "c"]);
  });

  it("refuses without low-disk headroom and builds nothing", async () => {
    db.markIndexOwner();
    await insert("a", "alpha zebrafish");
    vi.spyOn(db as any, "getAvailableBytes").mockReturnValue(
      DISK_LOW_BYTES - 1,
    );
    await expect(db.buildMissingFTSIndex()).rejects.toThrow(/disk pressure/);
    expect(await ftsIndices()).toHaveLength(0);
  });

  it("refuses a second concurrent build request", async () => {
    db.markIndexOwner();
    await insert("a", "alpha zebrafish");
    const first = db.buildMissingFTSIndex();
    await expect(db.buildMissingFTSIndex()).rejects.toThrow(/already running/);
    await expect(first).resolves.toMatchObject({ status: "built" });
    expect(await ftsIndices()).toHaveLength(1);
  });
});
