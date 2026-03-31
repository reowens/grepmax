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

export const similar = new Command("similar")
  .description("Find semantically similar code to a symbol or file")
  .argument("<target>", "Symbol name or file path")
  .option("-m, --max-count <n>", "Max results (default 5)", "5")
  .option("--threshold <score>", "Min similarity 0-1 (default 0)")
  .option("--root <dir>", "Project root directory")
  .option("--agent", "Compact output for AI agents", false)
  .action(async (target, opts) => {
    const limit = Math.min(
      Math.max(Number.parseInt(opts.maxCount || "5", 10), 1),
      25,
    );
    const threshold = Number.parseFloat(opts.threshold || "0") || 0;
    let vectorDb: VectorDB | null = null;

    try {
      const root = opts.root ? path.resolve(opts.root) : process.cwd();
      const projectRoot = findProjectRoot(root) ?? root;
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      const table = await vectorDb.ensureTable();
      const isFile =
        target.includes("/") || (target.includes(".") && !target.includes(" "));

      // Look up the source chunk's vector
      let sourceRows: any[];
      if (isFile) {
        const absPath = target.startsWith("/")
          ? target
          : path.resolve(projectRoot, target);
        sourceRows = await table
          .query()
          .select(["vector", "path", "defined_symbols", "start_line"])
          .where(`path = '${escapeSqlString(absPath)}'`)
          .limit(1)
          .toArray();
      } else {
        sourceRows = await table
          .query()
          .select(["vector", "path", "defined_symbols", "start_line"])
          .where(`array_contains(defined_symbols, '${escapeSqlString(target)}')`)
          .limit(1)
          .toArray();
      }

      if (sourceRows.length === 0) {
        console.log(
          isFile
            ? `File not found in index: ${target}`
            : `Symbol not found: ${target}`,
        );
        process.exitCode = 1;
        return;
      }

      const source = sourceRows[0];
      const sourceVector = source.vector;
      const sourcePath = String(source.path || "");

      if (!sourceVector || sourceVector.length === 0) {
        console.log("Source chunk has no embedding vector.");
        process.exitCode = 1;
        return;
      }

      // Vector search using the source chunk's embedding
      const pathScope = `path LIKE '${escapeSqlString(projectRoot)}/%'`;
      const results = await table
        .vectorSearch(sourceVector)
        .select([
          "path",
          "start_line",
          "end_line",
          "defined_symbols",
          "role",
          "content",
          "_distance",
        ])
        .where(pathScope)
        .limit(limit + 5) // fetch extra to account for self-filtering
        .toArray();

      // Filter out self and apply threshold
      const filtered = results.filter((r: any) => {
        if (r.path === sourcePath && r.start_line === source.start_line) return false;
        if (threshold > 0) {
          // LanceDB returns L2 distance; convert to similarity
          const sim = 1 / (1 + (r._distance || 0));
          if (sim < threshold) return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        console.log(`No similar code found for ${target}.`);
        return;
      }

      const rel = (p: string) =>
        p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;

      if (opts.agent) {
        for (const r of filtered.slice(0, limit)) {
          const sym = toArr(r.defined_symbols)?.[0] ?? "";
          const line = (r.start_line ?? 0) + 1;
          const role = (r.role || "IMPL").slice(0, 4);
          const dist = (r._distance ?? 0).toFixed(3);
          console.log(`${rel(r.path)}:${line}\t${sym}\t[${role}]\td=${dist}`);
        }
      } else {
        console.log(`Code similar to ${target}:\n`);
        for (const r of filtered.slice(0, limit)) {
          const sym = toArr(r.defined_symbols)?.[0] ?? "";
          const line = (r.start_line ?? 0) + 1;
          const role = r.role || "IMPLEMENTATION";
          const dist = (r._distance ?? 0).toFixed(3);
          console.log(`  ${rel(r.path)}:${line}  ${sym}  [${role}]  (distance: ${dist})`);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Similar search failed:", msg);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try { await vectorDb.close(); } catch {}
      }
      await gracefulExit();
    }
  });
