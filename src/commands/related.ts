import * as path from "node:path";
import { Command } from "commander";
import { VectorDB } from "../lib/store/vector-db";
import { fileNotFoundLines } from "../lib/utils/agent-errors";
import { toArr } from "../lib/utils/arrow";
import { gracefulExit } from "../lib/utils/exit";
import { escapeSqlString } from "../lib/utils/filter-builder";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import { withQueryTimeout } from "../lib/utils/query-timeout";
import {
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";

export const related = new Command("related")
  .description("Find files related by shared symbol references")
  .argument("<file>", "File path relative to project root")
  .option("-l, --limit <n>", "Max results per direction (default 10)", "10")
  .option("--root <dir>", "Project root directory")
  .option(
    "--in <subpath>",
    "Restrict to a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option(
    "--exclude <subpath>",
    "Exclude a sub-path of the project (repeatable)",
    (value: string, prev: string[] | undefined) =>
      prev ? [...prev, value] : [value],
  )
  .option("--agent", "Compact output for AI agents", false)
  .action(async (file, opts) => {
    const limit = Math.min(
      Math.max(Number.parseInt(opts.limit || "10", 10), 1),
      25,
    );
    let vectorDb: VectorDB | null = null;

    try {
      const root = resolveRootOrExit(opts.root);
      if (root === null) return;
      const projectRoot = findProjectRoot(root) ?? root;
      maybeWarnStaleChunker(projectRoot, { agent: opts.agent });
      maybeWarnStaleEmbedding(projectRoot, { agent: opts.agent });
      const paths = ensureProjectPaths(projectRoot);
      vectorDb = new VectorDB(paths.lancedbDir);

      const absPath = path.resolve(projectRoot, file);
      const table = await vectorDb.ensureTable();
      const { resolveScope, buildScopeWhere } = await import(
        "../lib/utils/scope-filter"
      );
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });
      const pathScope = buildScopeWhere(scope);

      const fileChunks = await table
        .query()
        .select(["defined_symbols", "referenced_symbols"])
        .where(`path = '${escapeSqlString(absPath)}'`)
        .toArray();

      if (fileChunks.length === 0) {
        console.log(fileNotFoundLines(file, { agent: opts.agent }).join("\n"));
        process.exitCode = 1;
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

      const topDeps = Array.from(depCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
      const topRevs = Array.from(revCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);

      // Mention-based fallback: when symbol intersection turns up nothing
      // in either direction, look for files in scope whose content mentions
      // this file's basename. Catches leaf modules with no shared symbols
      // and side-effect-only imports.
      const GENERIC_BASENAMES = new Set([
        "index",
        "main",
        "mod",
        "init",
        "lib",
        "types",
        "util",
        "utils",
        "common",
        "shared",
      ]);
      const mentions: string[] = [];
      let basename = "";
      let basenameRejected = false;
      if (topDeps.length === 0 && topRevs.length === 0) {
        const ext = path.extname(absPath);
        basename = path.basename(absPath, ext);
        if (
          basename.length < 4 ||
          GENERIC_BASENAMES.has(basename.toLowerCase())
        ) {
          basenameRejected = true;
        } else {
          // No .limit() here: LIKE + limit deadlocks in @lancedb 0.27.x when
          // more rows match than the limit (verified). The loop below caps.
          const rows = await withQueryTimeout(
            table
              .query()
              .select(["path"])
              .where(
                `content LIKE '%${escapeSqlString(basename)}%' AND ${pathScope}`,
              )
              .toArray(),
            `content LIKE %${basename}% (related mentions)`,
          );
          const seen = new Set<string>();
          for (const row of rows) {
            const p = String((row as any).path || "");
            if (!p || p === absPath) continue;
            if (seen.has(p)) continue;
            seen.add(p);
            mentions.push(p);
            if (mentions.length >= limit) break;
          }
        }
      }

      if (opts.agent) {
        const rel = (p: string) =>
          p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p;
        for (const [p, count] of topDeps) {
          console.log(`dep: ${rel(p)}\t${count}`);
        }
        for (const [p, count] of topRevs) {
          console.log(`rev: ${rel(p)}\t${count}`);
        }
        if (!topDeps.length && !topRevs.length) {
          if (basenameRejected) {
            console.log(
              `(no semantic neighbors; basename '${basename}' too generic to fall back)`,
            );
          } else if (mentions.length > 0) {
            console.log(
              `(no semantic neighbors; showing ${mentions.length} files mentioning '${basename}')`,
            );
            for (const p of mentions) {
              console.log(`imp: ${rel(p)}\t1`);
            }
          } else {
            console.log("(none)");
          }
        }
      } else {
        console.log(`Related files for ${file}:\n`);

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

        if (topDeps.length === 0 && topRevs.length === 0) {
          console.log("");
          if (basenameRejected) {
            console.log(
              `(basename '${basename}' too generic to fall back to mentions)`,
            );
          } else if (mentions.length > 0) {
            console.log(`Mentions of "${basename}" in other files:`);
            for (const p of mentions) {
              const rel = p.startsWith(`${projectRoot}/`)
                ? p.slice(projectRoot.length + 1)
                : p;
              console.log(`  ${rel}`);
            }
          }
        }
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
