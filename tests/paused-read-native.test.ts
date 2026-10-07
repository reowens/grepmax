import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import {
  PAUSED_CACHE_OPTIONS,
  searchPausedIndex,
} from "../src/lib/daemon/paused-reads";
import * as lance from "../src/lib/store/lance-sdk";
import { VectorDB } from "../src/lib/store/vector-db";

// This file only opens the fresh temporary fixture below. Host quarantine
// is mocked for fixture creation; VectorDB's explicit read-only guard is real.
vi.mock("../src/lib/store/maintenance-policy", async (original) => ({
  ...(await original<typeof import("../src/lib/store/maintenance-policy")>()),
  assertStoreMutationAllowed: () => {},
  storeMutationDeniedReason: () => null,
}));
vi.mock("../src/lib/utils/project-registry", async (original) => ({
  ...(await original<typeof import("../src/lib/utils/project-registry")>()),
  listProjects: () => [{ root: "/fixture", status: "indexed" }],
}));
vi.mock("../src/lib/workers/pool", () => ({
  getWorkerPool: () => {
    throw new Error("paused search must not load a worker");
  },
}));

it("serves existing FTS under read-only guards with bounded projections and no manifest changes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-paused-native-"));
  const writer = new VectorDB(dir, 384);
  let reader: VectorDB | undefined;
  try {
    const seed = (writer as any).seedRow();
    await writer.insertBatch(
      Array.from({ length: 30 }, (_, i) => ({
        ...seed,
        id: `r-${i}`,
        path: `/fixture/${i}.ts`,
        hash: `hash-${i}`,
        content:
          `function pressureFixture${i}() { return 'pressure fixture'; }\n` +
          "x".repeat(10_000),
        defined_symbols: [`pressureFixture${i}`],
        start_line: i,
      })),
    );
    const table = await writer.ensureTable();
    await table.createIndex("content", {
      config: lance.Index.fts({ withPosition: true }),
    });
    // This late fragment must never trigger an unindexed FTS corpus scan.
    await writer.insertBatch([
      {
        ...seed,
        id: "late",
        path: "/fixture/late.ts",
        content: "lateuniquetoken pressure",
        hash: "late-hash",
      },
    ]);
    await table.checkoutLatest();
    const version = await table.version();
    await writer.close();
    reader = new VectorDB(dir, 384, undefined, PAUSED_CACHE_OPTIONS);
    reader.markIndexOwner(); // Even an owner cannot write in read-only mode.
    expect(reader.canBuildIndexes()).toBe(false);
    const result = await searchPausedIndex(
      reader,
      { projectRoot: "/fixture", query: "pressure", limit: 100 },
      "memory warning",
      new AbortController().signal,
    );
    const unindexed = await searchPausedIndex(
      reader,
      { projectRoot: "/fixture", query: "lateuniquetoken", limit: 1 },
      "memory warning",
      new AbortController().signal,
    );
    expect(unindexed.data).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(20);
    expect(
      result.data!.every(
        (r) =>
          r.text!.length <= 8192 && r.metadata!.path.startsWith("/fixture/"),
      ),
    ).toBe(true);
    expect(result.warnings!.join(" ")).toContain("Keyword search only");
    expect(result.warnings!.join(" ")).toContain("limited to 20");
    expect(await (await reader.ensureTable()).version()).toBe(version);
    await expect(
      reader.insertBatch([{ ...seed, id: "forbidden" }]),
    ).rejects.toThrow("read-only");
    await expect(
      reader.withExclusiveTableMutation(async () => {}),
    ).rejects.toThrow("read-only");
    await expect(reader.upgradeStoreLease()).rejects.toThrow("read-only");
    expect(reader.cacheSizeBytes()).toBeLessThanOrEqual(48 * 1024 * 1024);
  } finally {
    await writer.close();
    await reader?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
