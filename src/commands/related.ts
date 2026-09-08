import * as path from "node:path";
import { Command } from "commander";
import {
  type LocatedRow,
  type RowMatch,
  readRows,
} from "../lib/daemon/rows-handler";
import { fileNotFoundLines } from "../lib/utils/agent-errors";
import { gracefulExit } from "../lib/utils/exit";
import { resolveContainedExistingPath } from "../lib/utils/path-containment";
import { resolveRootOrExit } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";
import {
  maybeWarnStaleChunker,
  maybeWarnStaleEmbedding,
} from "../lib/utils/stale-hint";
import { reportStoreAccessRefusal } from "../lib/utils/store-access";

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

    try {
      const root = resolveRootOrExit(opts.root);
      if (root === null) return;
      const projectRoot = findProjectRoot(root) ?? root;
      maybeWarnStaleChunker(projectRoot, { agent: opts.agent });
      maybeWarnStaleEmbedding(projectRoot, { agent: opts.agent });
      const paths = ensureProjectPaths(projectRoot);

      const absPath =
        resolveContainedExistingPath(projectRoot, file) ??
        path.resolve(projectRoot, file);
      const { resolveScope } = await import("../lib/utils/scope-filter");
      const scope = resolveScope({
        projectRoot,
        in: opts.in,
        exclude: opts.exclude,
      });

      const locate = (
        matches: RowMatch[],
        select: string[],
        rowLimit: number | undefined,
        scoped = true,
      ): Promise<LocatedRow[][]> =>
        readRows({
          name: "related",
          projectRoot,
          lancedbDir: paths.lancedbDir,
          scope,
          select,
          matches,
          limit: rowLimit,
          scoped,
        });

      // The file's own chunks. Unscoped, exactly as before: the file was named
      // explicitly, so an --in that excludes it must not hide it from itself.
      const [fileChunks] = await locate(
        [{ kind: "path", path: absPath }],
        ["defined_symbols", "referenced_symbols"],
        undefined,
        false,
      );

      if (!fileChunks || fileChunks.length === 0) {
        console.log(fileNotFoundLines(file, { agent: opts.agent }).join("\n"));
        process.exitCode = 1;
        return;
      }

      const definedHere = new Set<string>();
      const referencedHere = new Set<string>();
      for (const chunk of fileChunks) {
        for (const s of (chunk.defined_symbols as string[]) ?? [])
          definedHere.add(s);
        for (const s of (chunk.referenced_symbols as string[]) ?? [])
          referencedHere.add(s);
      }

      // Dependencies. One batched round trip instead of one per symbol — the
      // daemon runs the same N selects, the socket carries one request.
      const depSymbols = [...referencedHere].filter((s) => !definedHere.has(s));
      const depResults = await locate(
        depSymbols.map((symbol) => ({
          kind: "definedSymbol" as const,
          symbol,
        })),
        ["path"],
        3,
      );
      const depCounts = new Map<string, number>();
      for (const rows of depResults) {
        for (const row of rows) {
          const p = String(row.path || "");
          if (p === absPath) continue;
          depCounts.set(p, (depCounts.get(p) || 0) + 1);
        }
      }

      // Dependents
      const revResults = await locate(
        [...definedHere].map((symbol) => ({
          kind: "referencedSymbol" as const,
          symbol,
        })),
        ["path"],
        20,
      );
      const revCounts = new Map<string, number>();
      for (const rows of revResults) {
        for (const row of rows) {
          const p = String(row.path || "");
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
          // Still no .limit(): LIKE + limit deadlocks in @lancedb when more
          // rows match than the limit (verified). The verb caps the wire
          // response at MAX_LOCATE_ROWS; the loop below caps the output.
          const [rows] = await locate(
            [{ kind: "contentLike", value: basename }],
            ["path"],
            undefined,
          );
          const seen = new Set<string>();
          for (const row of rows ?? []) {
            const p = String(row.path || "");
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
      if (!reportStoreAccessRefusal(error)) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("Related files failed:", msg);
        process.exitCode = 1;
      }
    } finally {
      await gracefulExit();
    }
  });
