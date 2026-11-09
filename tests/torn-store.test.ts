import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../src/config";
import { MetaCache } from "../src/lib/store/meta-cache";
import { StoreLease } from "../src/lib/store/store-lease";
import {
  assessTornStore,
  isTornStoreError,
  reconcileMetaWithTable,
  repairTornStore,
} from "../src/lib/store/torn-store";
import type { VectorRecord } from "../src/lib/store/types";
import { VectorDB } from "../src/lib/store/vector-db";

// Native fixtures create only temporary stores. Keep their admission independent
// of the host's no-autostart/quarantine state without changing production policy.
vi.mock("../src/lib/store/maintenance-policy", async (original) => ({
  ...(await original<typeof import("../src/lib/store/maintenance-policy")>()),
  assertStoreMutationAllowed: () => {},
  storeMutationDeniedReason: () => null,
}));

const DIM = 8;
const NOW = new Date(2026, 10, 8, 17, 53, 0);

function record(filePath: string, hash: string, seed: number): VectorRecord {
  return {
    id: `${path.basename(filePath)}-${seed}`,
    path: filePath,
    hash,
    content: `content ${seed}`,
    start_line: seed,
    end_line: seed + 1,
    vector: new Float32Array(DIM).fill(seed / 10),
    colbert: Buffer.from([seed, seed + 1, 255]),
    colbert_scale: 1,
    pooled_colbert_48d: new Float32Array(CONFIG.COLBERT_DIM).fill(seed),
    doc_token_ids: [seed],
  };
}

let root: string;
let storeDir: string;
let tableDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-torn-"));
  storeDir = path.join(root, "lancedb");
  tableDir = path.join(storeDir, "chunks.lance");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const list = (dir: string) => new Set(fs.readdirSync(path.join(tableDir, dir)));

/** Batch A is the older whole version; batch B is the commit a power loss tears. */
async function buildStore() {
  const db = new VectorDB(storeDir, DIM);
  await db.ensureTable();
  const dataEmpty = list("data");
  await db.insertBatch([
    record("/repo/a.ts", "ha", 1),
    record("/repo/c.ts", "hc-old", 2),
  ]);
  const dataBefore = list("data");
  const versionsBefore = list("_versions");
  await db.insertBatch([record("/repo/b.ts", "hb", 3)]);
  await db.close();
  const newData = [...list("data")].filter((n) => !dataBefore.has(n));
  const newManifests = [...list("_versions")].filter(
    (n) => !versionsBefore.has(n),
  );
  expect(newData).toHaveLength(1);
  expect(newManifests).toHaveLength(1);
  return {
    latestManifest: `_versions/${newManifests[0]}`,
    newData: `data/${newData[0]}`,
    batchAData: `data/${[...dataBefore].find((n) => !dataEmpty.has(n))}`,
  };
}

async function withExclusive<T>(fn: () => T): Promise<T> {
  const lease = await StoreLease.acquireExclusive({
    storeDir,
    timeoutMs: 2000,
  });
  try {
    return fn();
  } finally {
    await lease.release();
  }
}

const quarantines = () =>
  fs.readdirSync(root).filter((n) => n.startsWith("quarantine-"));

describe("torn store recovery", () => {
  it("rolls a torn tail back to the newest whole version and reindexes what it lost", async () => {
    const torn = await buildStore();
    const before = assessTornStore(tableDir);
    expect(before.status).toBe("healthy");
    const wholeVersion = before.latestVersion! - 1;

    fs.truncateSync(path.join(tableDir, torn.latestManifest), 0);
    fs.truncateSync(path.join(tableDir, torn.newData), 0);

    // The damage is real: opening the table fails, and the failure is classified.
    const onStoreDamage = vi.fn();
    const broken = new VectorDB(storeDir, DIM, undefined, { onStoreDamage });
    const failure = await broken.getDistinctPathsForPrefix("/repo/").then(
      () => null,
      (err: unknown) => err,
    );
    await broken.close();
    expect(failure).not.toBeNull();
    expect(isTornStoreError(failure)).toBe(true);
    expect(onStoreDamage).toHaveBeenCalledOnce();

    const found = assessTornStore(tableDir);
    expect(found.status).toBe("repairable");
    expect(found.restoreVersion).toBe(wholeVersion);
    expect(found.moves.map((f) => f.path).sort()).toEqual(
      [torn.latestManifest, torn.newData].sort(),
    );

    const result = await withExclusive(() =>
      repairTornStore(storeDir, "chunks", NOW),
    );
    expect(result.quarantineDir).toBe(
      path.join(root, "quarantine-torn-store-20261108-175300"),
    );
    expect(result.moved.map((f) => f.path).sort()).toEqual(
      [torn.latestManifest, torn.newData].sort(),
    );
    expect(result.summary).toContain(`to whole version ${wholeVersion}`);
    for (const rel of [torn.latestManifest, torn.newData]) {
      expect(fs.existsSync(path.join(tableDir, rel))).toBe(false);
      expect(
        fs.statSync(path.join(result.quarantineDir!, "chunks.lance", rel)).size,
      ).toBe(0);
    }
    const moved = fs.readFileSync(
      path.join(result.quarantineDir!, "moved.txt"),
      "utf8",
    );
    expect(moved).toContain(`restored version ${wholeVersion}`);
    expect(moved).toContain(`${torn.latestManifest}\t0\tempty`);
    expect(moved).toContain(`${torn.newData}\t0\tempty`);
    expect(assessTornStore(tableDir).status).toBe("healthy");

    const db = new VectorDB(storeDir, DIM);
    expect(await db.getDistinctPathsForPrefix("/repo/")).toEqual(
      new Set(["/repo/a.ts", "/repo/c.ts"]),
    );

    // b.ts was only in the lost commit; c.ts was re-embedded in it, so the
    // restored table holds its older rows.
    const meta = new MetaCache(path.join(root, "meta.lmdb"));
    meta.put("/repo/a.ts", {
      hash: "ha",
      mtimeMs: 1,
      size: 1,
      hasVectors: true,
    });
    meta.put("/repo/b.ts", {
      hash: "hb",
      mtimeMs: 1,
      size: 1,
      hasVectors: true,
    });
    meta.put("/repo/c.ts", {
      hash: "hc-new",
      mtimeMs: 1,
      size: 1,
      hasVectors: true,
    });
    meta.put("/repo/empty.ts", {
      hash: "he",
      mtimeMs: 1,
      size: 0,
      hasVectors: false,
    });

    const dry = await reconcileMetaWithTable(db, meta, { dryRun: true });
    expect(dry).toEqual([
      { path: "/repo/b.ts", reason: "no rows" },
      { path: "/repo/c.ts", reason: "rows from an older revision" },
    ]);
    expect(meta.get("/repo/b.ts")).toBeDefined();

    await reconcileMetaWithTable(db, meta, { dryRun: false });
    expect(meta.get("/repo/a.ts")).toBeDefined();
    expect(meta.get("/repo/b.ts")).toBeUndefined();
    expect(meta.get("/repo/c.ts")).toBeUndefined();
    expect(meta.get("/repo/empty.ts")).toBeDefined();
    await meta.close();

    // The store takes new commits after the rollback.
    await db.insertBatch([record("/repo/b.ts", "hb", 4)]);
    expect(await db.getDistinctPathsForPrefix("/repo/")).toEqual(
      new Set(["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"]),
    );
    await db.close();
  });

  it("leaves a whole store untouched", async () => {
    await buildStore();
    const files = (dir: string) => [...list(dir)].sort();
    const snapshot = ["_versions", "data", "_transactions"].map(files);
    expect(assessTornStore(tableDir).status).toBe("healthy");
    const result = await withExclusive(() => repairTornStore(storeDir));
    expect(result.moved).toEqual([]);
    expect(result.quarantineDir).toBeNull();
    expect(quarantines()).toEqual([]);
    expect(["_versions", "data", "_transactions"].map(files)).toEqual(snapshot);
  });

  it("refuses when the version below the torn one names a damaged file", async () => {
    const torn = await buildStore();
    fs.truncateSync(path.join(tableDir, torn.latestManifest), 0);
    fs.truncateSync(path.join(tableDir, torn.batchAData), 0);

    const found = assessTornStore(tableDir);
    expect(found.status).toBe("refused");
    expect(found.refusals[0].reason).toContain(`${torn.batchAData} empty`);
    const result = await withExclusive(() => repairTornStore(storeDir));
    expect(result.moved).toEqual([]);
    expect(quarantines()).toEqual([]);
    expect(fs.existsSync(path.join(tableDir, torn.latestManifest))).toBe(true);
    expect(fs.existsSync(path.join(tableDir, torn.batchAData))).toBe(true);
  });

  it("refuses when a damaged file is older than the newest whole version", async () => {
    const torn = await buildStore();
    fs.truncateSync(path.join(tableDir, torn.latestManifest), 0);
    const stale = path.join(tableDir, "data", "old-orphan.lance");
    fs.writeFileSync(stale, "");
    fs.utimesSync(stale, new Date(2000, 0, 1), new Date(2000, 0, 1));

    const found = assessTornStore(tableDir);
    expect(found.status).toBe("refused");
    expect(found.refusals).toEqual([
      expect.objectContaining({
        path: "data/old-orphan.lance",
        reason: expect.stringContaining("older than version"),
      }),
    ]);
    const result = await withExclusive(() => repairTornStore(storeDir));
    expect(result.moved).toEqual([]);
    expect(quarantines()).toEqual([]);
    expect(fs.existsSync(stale)).toBe(true);
  });

  it("refuses to move anything without the exclusive store lease", async () => {
    const torn = await buildStore();
    fs.truncateSync(path.join(tableDir, torn.latestManifest), 0);
    expect(() => repairTornStore(storeDir)).toThrow(/exclusive store lease/);
    expect(quarantines()).toEqual([]);
  });

  it("classifies the error a 0-byte manifest produces", () => {
    expect(
      isTornStoreError(
        new Error(
          "lance error: LanceError(IO): Generic memory error: Invalid range 0..0 for object of size 0 bytes, /lance-14.0.2/src/dataset.rs:776:26",
        ),
      ),
    ).toBe(true);
    expect(isTornStoreError(new Error("Table 'chunks' was not found"))).toBe(
      false,
    );
  });
});
