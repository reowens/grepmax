import { VectorDB } from "./src/lib/store/vector-db";
import {
  ensureProjectPaths,
  findProjectRoot,
} from "./src/lib/utils/project-root";

async function debugDb() {
  const root = await findProjectRoot();
  const paths = await ensureProjectPaths(root);
  const db = new VectorDB(paths.lancedbDir);
  const table = await db.ensureTable();

  const count = await table.countRows();
  console.log(`Total rows: ${count}`);

  const rows = await table.query().limit(5).toArray();
  console.log(
    "Sample rows:",
    JSON.stringify(
      rows.map((r) => ({
        path: r.path,
        defined: r.defined_symbols,
        role: r.role,
      })),
      null,
      2,
    ),
  );

  console.log("Searching for 'Searcher' in defined_symbols...");
  // Try a manual scan if array_contains fails
  const allRows = await table.query().toArray();

  const searcherFile = allRows.filter((r) => r.path.endsWith("searcher.ts"));
  console.log(`Found ${searcherFile.length} chunks for searcher.ts`);

  const searcherRefs = allRows.filter((r) => {
    const refs = r.referenced_symbols;
    let converted: any = [];
    try {
      if (Array.isArray(refs)) converted = refs;
      else if (refs && typeof refs.toArray === "function")
        converted = refs.toArray();
    } catch (e) {}
    return Array.isArray(converted) && converted.includes("Searcher");
  });

  console.log(`Found ${searcherRefs.length} chunks referencing Searcher`);
  searcherRefs.slice(0, 5).forEach((r) => {
    console.log("Ref Chunk:", {
      path: r.path,
      role: r.role,
      contentPreview: r.content.slice(0, 100),
    });
  });

  searcherFile.forEach((r) => {
    const defs = r.defined_symbols;
    let converted: any = "FAILED";
    try {
      if (Array.isArray(defs)) converted = defs;
      else if (defs && typeof defs.toArray === "function") {
        converted = defs.toArray();
      }
    } catch (e) {
      converted = `Error: ${e}`;
    }

    console.log("Definition Chunk:", {
      path: r.path,
      defined: converted,
      contentPreview: r.content.slice(0, 100),
    });
  });

  const searcherDef = allRows.find((r) => {
    let defs = r.defined_symbols;
    if (defs && typeof defs.toArray === "function") {
      defs = defs.toArray();
    }
    if (Array.isArray(defs) && defs.length > 0) {
      console.log("Checking defs:", defs);
    }
    return Array.isArray(defs) && defs.includes("Searcher");
  });

  if (searcherDef) {
    console.log("Found Searcher manually:", {
      path: searcherDef.path,
      role: searcherDef.role,
      defined: searcherDef.defined_symbols,
    });
  } else {
    console.log("Searcher NOT found manually.");
  }
}

debugDb().catch(console.error);
