import * as path from "node:path";
import { Command } from "commander";
import { VectorDB } from "../lib/store/vector-db";
import { escapeSqlString } from "../lib/utils/filter-builder";
import { gracefulExit } from "../lib/utils/exit";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

function toArr(val: unknown): string[] {
  if (val && typeof (val as any).toArray === "function") {
    return (val as any).toArray();
  }
  return Array.isArray(val) ? val : [];
}

export const related = new Command("related")
  .description("Find files related by shared symbol references")
  .argument("<file>", "File path relative to project root")
  .option("-l, --limit <n>", "Max results per direction (default 10)", "10")
  .option("--root <dir>", "Project root directory")
  .action(async (file, opts) => {
    const limit = Math.min(
      Math.max(Number.parseInt(opts.limit || "10", 10), 1),
      25,
    );
    let vectorDb: VectorDB | null = null;

    try {
      const root = opts.root ? path.resolve(opts.root) : process.cwd();
      const projectRoot = findProjectRoot(root) ?? root;
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      const absPath = path.resolve(projectRoot, file);
      const table = await vectorDb.ensureTable();
      const pathScope = `path LIKE '${escapeSqlString(projectRoot)}/%'`;

      const fileChunks = await table
        .query()
        .select(["defined_symbols", "referenced_symbols"])
        .where(`path = '${escapeSqlString(absPath)}'`)
        .toArray();

      if (fileChunks.length === 0) {
        console.log(`File not found in index: ${file}`);
        return;
      }

      const definedHere = new Set<string>();
      const referencedHere = new Set<string>();
      for (const chunk of fileChunks) {
        for (const s of toArr((chunk as any).defined_symbols))
          definedHere.add(s);
        for (const s of toArr((chunk as any).referenced_symbols))
          referencedHere.add(s);
      }

      // Dependencies
      const depCounts = new Map<string, number>();
      for (const sym of referencedHere) {
        if (definedHere.has(sym)) continue;
        const rows = await table
          .query()
          .select(["path"])
          .where(
            `array_contains(defined_symbols, '${escapeSqlString(sym)}') AND ${pathScope}`,
          )
          .limit(3)
          .toArray();
        for (const row of rows) {
          const p = String((row as any).path || "");
          if (p === absPath) continue;
          depCounts.set(p, (depCounts.get(p) || 0) + 1);
        }
      }

      // Dependents
      const revCounts = new Map<string, number>();
      for (const sym of definedHere) {
        const rows = await table
          .query()
          .select(["path"])
          .where(
            `array_contains(referenced_symbols, '${escapeSqlString(sym)}') AND ${pathScope}`,
          )
          .limit(20)
          .toArray();
        for (const row of rows) {
          const p = String((row as any).path || "");
          if (p === absPath) continue;
          revCounts.set(p, (revCounts.get(p) || 0) + 1);
        }
      }

      console.log(`Related files for ${file}:\n`);

      const topDeps = Array.from(depCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
      if (topDeps.length > 0) {
        console.log("Dependencies (files this imports/calls):");
        for (const [p, count] of topDeps) {
          const rel = p.startsWith(`${projectRoot}/`)
            ? p.slice(projectRoot.length + 1)
            : p;
          console.log(
            `  ${rel.padEnd(40)} (${count} shared symbol${count > 1 ? "s" : ""})`,
          );
        }
      } else {
        console.log("Dependencies: none found");
      }

      console.log("");

      const topRevs = Array.from(revCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
      if (topRevs.length > 0) {
        console.log("Dependents (files that call this):");
        for (const [p, count] of topRevs) {
          const rel = p.startsWith(`${projectRoot}/`)
            ? p.slice(projectRoot.length + 1)
            : p;
          console.log(
            `  ${rel.padEnd(40)} (${count} shared symbol${count > 1 ? "s" : ""})`,
          );
        }
      } else {
        console.log("Dependents: none found");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Related files failed:", msg);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try {
          await vectorDb.close();
        } catch {}
      }
      await gracefulExit();
    }
  });
