/** Native LIKE+limit regression probe. Always uses synthetic temporary data. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { connect, Session } from "./lib/store/lance-sdk";
import { escapeSqlString } from "./lib/utils/filter-builder";
import { withQueryTimeout } from "./lib/utils/query-timeout";

async function main(): Promise<void> {
  const needle = process.argv[2] || "Fixture";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-like-probe-"));
  const db = await connect(dir, {
    session: new Session(BigInt(8 * 1024 ** 2), BigInt(8 * 1024 ** 2)),
  });
  try {
    const table = await db.createTable(
      "probe",
      Array.from({ length: 200 }, (_, i) => ({
        path: `/fixture/${i}.ts`,
        content: `import ${needle}`,
      })),
    );
    const where = `content LIKE '%${escapeSqlString(needle)}%'`;
    const options = { timeoutMs: 5000 };
    const rows = await withQueryTimeout(
      table.query().select(["path"]).where(where).limit(7).toArray(options),
      "temporary LIKE+limit probe",
      6000,
    );
    if (rows.length !== 7)
      throw new Error(`Expected 7 rows, got ${rows.length}`);
    console.log("Temporary LIKE+limit probe: 7 of 200 matching rows returned");
    table.close();
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
