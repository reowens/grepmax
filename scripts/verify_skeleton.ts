import * as path from "path";
import { VectorDB } from "../src/lib/store/vector-db";
import { ensureProjectPaths } from "../src/lib/utils/project-root";

async function main() {
  const root = process.cwd();
  const paths = ensureProjectPaths(root);
  const db = new VectorDB(paths.lancedbDir);

  try {
    const table = await db.ensureTable();
    const results = await table
      .query()
      .where("path LIKE '%src/commands/skeleton.ts%' AND is_anchor = true")
      .limit(1)
      .toArray();

    console.log(`Found ${results.length} anchor chunks.`);

    for (const r of results) {
      console.log(`File: ${r.path}`);
      const skel = r["file_skeleton"];
      if (skel && typeof skel === "string" && skel.length > 0) {
        console.log("✅ Has skeleton (" + skel.length + " chars)");
        console.log(skel.substring(0, 50) + "...");
      } else {
        console.log("❌ No skeleton found!");
      }
      console.log("---");
    }
  } catch (e) {
    console.error(e);
  } finally {
    await db.close();
  }
}

main();
