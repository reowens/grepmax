import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";

it("the measured Session is the one native queries populate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-session-"));
  const db = new VectorDB(dir, 384);
  try {
    expect(await db.getSchemaVectorDim()).toBeNull();
    const before = db.cacheSizeBytes();
    const row = (db as any).seedRow();
    await db.insertBatch([
      { ...row, id: "a", path: "/fixture/a.ts", content: "session fixture" },
    ]);
    await db.createVectorIndex();
    expect(await db.hasRowsForPath("/fixture/")).toBe(true);
    // The legacy positional Session silently stayed empty on SDK 0.38 while
    // queries populated an unrelated default 6 GB / 1 GB native session.
    expect(db.cacheSizeBytes()).toBeGreaterThan(before);
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
