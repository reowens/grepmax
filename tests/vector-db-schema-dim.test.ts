import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";

// Real round-trip against LanceDB: proves getSchemaVectorDim reads the actual
// on-disk FixedSizeList width, which is what lets `gmax doctor` catch a table
// stranded at the old width after a model-tier change.
describe("VectorDB.getSchemaVectorDim", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-schema-dim-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no table exists yet", async () => {
    const db = new VectorDB(dir, 384);
    expect(await db.getSchemaVectorDim()).toBeNull();
    await db.close();
  });

  it("reads the physical width of an existing table", async () => {
    const db = new VectorDB(dir, 384);
    await db.ensureTable();
    expect(await db.getSchemaVectorDim()).toBe(384);
    await db.close();
  });

  it("reports the PHYSICAL width when the instance/config dim disagrees", async () => {
    // Build the table at 384d (the "small" tier)...
    const small = new VectorDB(dir, 384);
    await small.ensureTable();
    await small.close();

    // ...then reopen as if the tier switched to "standard" (768d). The table is
    // physically stranded at 384d; getSchemaVectorDim must report 384 (the
    // truth) rather than the 768 the instance now wants — otherwise doctor would
    // think everything is fine while every write throws.
    const standard = new VectorDB(dir, 768);
    expect(await standard.getSchemaVectorDim()).toBe(384);
    await standard.close();
  });

  it("creates the table when openTable reports chunks is missing", async () => {
    const table = {
      delete: vi.fn(async () => {}),
    };
    const conn = {
      openTable: vi.fn(async () => {
        throw new Error("Table 'chunks' does not exist");
      }),
      createTable: vi.fn(async () => table),
      close: vi.fn(async () => {}),
    };
    const db = new VectorDB(dir, 384);
    (db as any).db = conn;

    await expect(db.ensureTable()).resolves.toBe(table);

    expect(conn.createTable).toHaveBeenCalledOnce();
    expect(table.delete).toHaveBeenCalledWith('id = "seed"');
    await db.close();
  });

  it("does not recreate the table when schema validation fails", async () => {
    const table = {
      schema: vi.fn(async () => ({ fields: [] })),
    };
    const conn = {
      openTable: vi.fn(async () => table),
      createTable: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const db = new VectorDB(dir, 384);
    (db as any).db = conn;

    await expect(db.ensureTable()).rejects.toThrow("schema missing fields");

    expect(conn.createTable).not.toHaveBeenCalled();
    await db.close();
  });
});
