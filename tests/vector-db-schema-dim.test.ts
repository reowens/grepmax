import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
