import * as path from "node:path";
import { Command } from "commander";
import { VectorDB } from "../lib/store/vector-db";
import { escapeSqlString } from "../lib/utils/filter-builder";
import { gracefulExit } from "../lib/utils/exit";
import { listProjects } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

function toArr(val: unknown): string[] {
  if (val && typeof (val as any).toArray === "function") {
    return (val as any).toArray();
  }
  return Array.isArray(val) ? val : [];
}

export const project = new Command("project")
  .description("Show project overview — languages, structure, key symbols")
  .option("--root <dir>", "Project root (defaults to current directory)")
  .option("--agent", "Compact output for AI agents", false)
  .action(async (opts) => {
    let vectorDb: VectorDB | null = null;

    try {
      const root = opts.root
        ? findProjectRoot(path.resolve(opts.root)) ?? path.resolve(opts.root)
        : findProjectRoot(process.cwd()) ?? process.cwd();
      const prefix = root.endsWith("/") ? root : `${root}/`;
      const projectName = path.basename(root);
      const paths = ensureProjectPaths(root);
      vectorDb = new VectorDB(paths.lancedbDir);

      const table = await vectorDb.ensureTable();
      const rows = await table
        .query()
        .select([
          "path",
          "role",
          "is_exported",
          "complexity",
          "defined_symbols",
          "referenced_symbols",
        ])
        .where(`path LIKE '${escapeSqlString(prefix)}%'`)
        .limit(200000)
        .toArray();

      if (rows.length === 0) {
        console.log(
          `No indexed data found for ${root}. Run: gmax index --path ${root}`,
        );
        process.exitCode = 1;
        return;
      }

      const files = new Set<string>();
      const extCounts = new Map<string, number>();
      const dirCounts = new Map<
        string,
        { files: Set<string>; chunks: number }
      >();
      const roleCounts = new Map<string, number>();
      const symbolRefs = new Map<string, number>();
      const entryPoints: Array<{ symbol: string; path: string }> = [];

      for (const row of rows) {
        const p = String((row as any).path || "");
        const role = String((row as any).role || "IMPLEMENTATION");
        const exported = Boolean((row as any).is_exported);
        const complexity = Number((row as any).complexity || 0);
        const defs = toArr((row as any).defined_symbols);
        const refs = toArr((row as any).referenced_symbols);

        files.add(p);
        const ext = path.extname(p).toLowerCase() || path.basename(p);
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);

        const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
        const parts = rel.split("/");
        const dir =
          parts.length > 2
            ? `${parts.slice(0, 2).join("/")}/`
            : parts.length > 1
              ? `${parts[0]}/`
              : "(root)";
        if (!dirCounts.has(dir))
          dirCounts.set(dir, { files: new Set(), chunks: 0 });
        const dc = dirCounts.get(dir)!;
        dc.files.add(p);
        dc.chunks++;

        roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
        for (const ref of refs)
          symbolRefs.set(ref, (symbolRefs.get(ref) || 0) + 1);

        if (exported && role === "ORCHESTRATION" && complexity >= 5 && defs.length > 0) {
          entryPoints.push({
            symbol: defs[0],
            path: p.startsWith(prefix) ? p.slice(prefix.length) : p,
          });
        }
      }

      const projects = listProjects();
      const proj = projects.find((p) => p.root === root);

      const extEntries = Array.from(extCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      const topSymbols = Array.from(symbolRefs.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);

      if (opts.agent) {
        console.log(`name\t${projectName}`);
        console.log(`root\t${root}`);
        console.log(`chunks\t${rows.length}`);
        console.log(`files\t${files.size}`);
        console.log(`last_indexed\t${proj?.lastIndexed ?? "unknown"}`);
        console.log(
          `languages\t${extEntries.map(([ext]) => ext).join(",")}`,
        );
        console.log(
          `top_dirs\t${Array.from(dirCounts.entries()).sort((a, b) => b[1].chunks - a[1].chunks).slice(0, 8).map(([d]) => d).join(",")}`,
        );
        if (topSymbols.length > 0) {
          console.log(
            `key_symbols\t${topSymbols.map(([s]) => s).join(",")}`,
          );
        }
        if (entryPoints.length > 0) {
          console.log(
            `entry_points\t${entryPoints.slice(0, 10).map((e) => e.symbol).join(",")}`,
          );
        }
      } else {
        console.log(`Project: ${projectName} (${root})`);
        console.log(
          `Last indexed: ${proj?.lastIndexed ?? "unknown"} • ${rows.length} chunks • ${files.size} files\n`,
        );

        console.log(
          `Languages: ${extEntries.map(([ext, count]) => `${ext} (${Math.round((count / rows.length) * 100)}%)`).join(", ")}\n`,
        );

        console.log("Directory structure:");
        for (const [dir, data] of Array.from(dirCounts.entries())
          .sort((a, b) => b[1].chunks - a[1].chunks)
          .slice(0, 12)) {
          console.log(
            `  ${dir.padEnd(25)} (${data.files.size} files, ${data.chunks} chunks)`,
          );
        }

        const roleEntries = Array.from(roleCounts.entries()).sort(
          (a, b) => b[1] - a[1],
        );
        console.log(
          `\nRoles: ${roleEntries.map(([r, c]) => `${Math.round((c / rows.length) * 100)}% ${r}`).join(", ")}\n`,
        );

        if (topSymbols.length > 0) {
          console.log("Key symbols (by reference count):");
          for (const [sym, count] of topSymbols) {
            console.log(`  ${sym.padEnd(25)} (referenced ${count}x)`);
          }
        }

        if (entryPoints.length > 0) {
          console.log("\nEntry points (exported orchestration):");
          for (const ep of entryPoints.slice(0, 10)) {
            console.log(`  ${ep.symbol.padEnd(25)} ${ep.path}`);
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Project summary failed:", msg);
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
