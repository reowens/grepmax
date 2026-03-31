import * as path from "node:path";
import { Command } from "commander";
import { Searcher } from "../lib/search/searcher";
import { VectorDB } from "../lib/store/vector-db";
import { escapeSqlString } from "../lib/utils/filter-builder";
import { gracefulExit } from "../lib/utils/exit";
import { getChangedFiles } from "../lib/utils/git";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

function toArr(val: unknown): string[] {
  if (val && typeof (val as any).toArray === "function") {
    return (val as any).toArray();
  }
  return Array.isArray(val) ? val : [];
}

export const diff = new Command("diff")
  .description("Search code scoped to git changes")
  .argument("[ref]", "Git ref to diff against (e.g. main, HEAD~5)")
  .option("-q, --query <query>", "Semantic search within changed files")
  .option("-m, --max-count <n>", "Max results (default 10)", "10")
  .option("--role <role>", "Filter by role: ORCHESTRATION, DEFINITION, IMPLEMENTATION")
  .option("--root <dir>", "Project root directory")
  .option("--agent", "Compact output for AI agents", false)
  .action(async (ref, opts) => {
    const limit = Math.min(
      Math.max(Number.parseInt(opts.maxCount || "10", 10), 1),
      50,
    );
    let vectorDb: VectorDB | null = null;

    try {
      const root = opts.root ? path.resolve(opts.root) : process.cwd();
      const projectRoot = findProjectRoot(root) ?? root;
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      const changedFiles = getChangedFiles(ref, projectRoot);
      if (changedFiles.length === 0) {
        console.log(ref ? `No changes found relative to ${ref}.` : "No uncommitted changes found.");
        return;
      }

      const rel = (p: string) =>
        p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;

      if (opts.query) {
        // Semantic search scoped to changed files
        const searcher = new Searcher(vectorDb);
        const response = await searcher.search(
          opts.query,
          limit,
          { rerank: true },
          {
            ...(opts.role ? { role: opts.role } : {}),
          },
          projectRoot,
        );

        // Filter results to only changed files
        const changedSet = new Set(changedFiles);
        const filtered = response.data.filter((r) => {
          const p = (r.metadata as any)?.path || r.path || "";
          return changedSet.has(p);
        });

        if (filtered.length === 0) {
          console.log("No indexed results found in changed files for that query.");
          return;
        }

        if (opts.agent) {
          for (const r of filtered.slice(0, limit)) {
            const p = String((r as any).path || (r.metadata as any)?.path || "");
            const line = Number((r as any).start_line ?? 0);
            const sym = toArr((r as any).defined_symbols)?.[0] ?? "";
            const role = String((r as any).role || "IMPL");
            console.log(`${rel(p)}:${line + 1} ${sym} [${role}]`);
          }
        } else {
          console.log(`Changed files matching "${opts.query}":\n`);
          for (const r of filtered.slice(0, limit)) {
            const p = String((r as any).path || (r.metadata as any)?.path || "");
            const line = Number((r as any).start_line ?? 0);
            const sym = toArr((r as any).defined_symbols)?.[0] ?? "";
            const role = String((r as any).role || "IMPLEMENTATION");
            const score = r.score?.toFixed(3) ?? "?";
            console.log(`  ${rel(p)}:${line + 1}  ${sym}  [${role}]  (${score})`);
          }
        }
      } else {
        // No query — list changed files with their indexed symbols
        const table = await vectorDb.ensureTable();

        if (opts.agent) {
          for (const file of changedFiles) {
            const chunks = await table
              .query()
              .select(["path", "start_line", "defined_symbols", "role"])
              .where(`path = '${escapeSqlString(file)}'`)
              .limit(50)
              .toArray();

            if (chunks.length === 0) {
              console.log(`${rel(file)}\t(not indexed)`);
            } else {
              for (const chunk of chunks) {
                const sym = toArr((chunk as any).defined_symbols)?.[0] ?? "";
                const line = (chunk as any).start_line ?? 0;
                const role = ((chunk as any).role || "IMPL").slice(0, 4);
                if (sym) {
                  console.log(`${rel(file)}:${line + 1}\t${sym}\t[${role}]`);
                }
              }
            }
          }
        } else {
          console.log(`${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}${ref ? ` (vs ${ref})` : ""}:\n`);
          for (const file of changedFiles) {
            const chunks = await table
              .query()
              .select(["defined_symbols", "role"])
              .where(`path = '${escapeSqlString(file)}'`)
              .limit(50)
              .toArray();

            const symbols = chunks
              .flatMap((c: any) => toArr(c.defined_symbols))
              .filter(Boolean);

            if (symbols.length > 0) {
              console.log(`  ${rel(file)}  (${symbols.length} symbol${symbols.length === 1 ? "" : "s"}: ${symbols.slice(0, 5).join(", ")}${symbols.length > 5 ? "..." : ""})`);
            } else {
              console.log(`  ${rel(file)}`);
            }
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Diff failed:", msg);
      process.exitCode = 1;
    } finally {
      if (vectorDb) {
        try { await vectorDb.close(); } catch {}
      }
      await gracefulExit();
    }
  });
