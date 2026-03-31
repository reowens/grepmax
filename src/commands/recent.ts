import * as path from "node:path";
import { Command } from "commander";
import { PATHS } from "../config";
import { MetaCache } from "../lib/store/meta-cache";
import { gracefulExit } from "../lib/utils/exit";
import { formatTimeAgo } from "../lib/utils/format-helpers";
import { findProjectRoot } from "../lib/utils/project-root";

export const recent = new Command("recent")
  .description("Show recently modified indexed files")
  .option("-l, --limit <n>", "Max files (default 20)", "20")
  .option("--root <dir>", "Project root (defaults to current directory)")
  .option("--agent", "Compact output for AI agents", false)
  .action(async (opts) => {
    const limit = Math.min(
      Math.max(Number.parseInt(opts.limit || "20", 10), 1),
      50,
    );

    try {
      const root = opts.root
        ? findProjectRoot(path.resolve(opts.root)) ?? path.resolve(opts.root)
        : findProjectRoot(process.cwd()) ?? process.cwd();
      const prefix = root.endsWith("/") ? root : `${root}/`;

      const metaCache = new MetaCache(PATHS.lmdbPath);
      try {
        const files: Array<{ path: string; mtimeMs: number }> = [];
        for await (const { path: p, entry } of metaCache.entries()) {
          if (p.startsWith(prefix)) {
            files.push({ path: p, mtimeMs: entry.mtimeMs });
          }
        }
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const top = files.slice(0, limit);

        if (top.length === 0) {
          console.log(`No indexed files found for ${root}`);
          console.log(
            "\nTry: `gmax add` to register and index this project, or `gmax status` to see what's indexed.",
          );
          process.exitCode = 1;
          return;
        }

        const now = Date.now();
        if (opts.agent) {
          for (const f of top) {
            const rel = f.path.startsWith(prefix)
              ? f.path.slice(prefix.length)
              : f.path;
            console.log(`${rel}\t${formatTimeAgo(now - f.mtimeMs)}`);
          }
        } else {
          console.log(
            `Recent changes in ${path.basename(root)} (${top.length} most recent):\n`,
          );
          for (const f of top) {
            const rel = f.path.startsWith(prefix)
              ? f.path.slice(prefix.length)
              : f.path;
            const ago = formatTimeAgo(now - f.mtimeMs);
            console.log(`  ${ago.padEnd(10)} ${rel}`);
          }
        }
      } finally {
        await metaCache.close();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Recent changes failed:", msg);
      process.exitCode = 1;
    }

    await gracefulExit();
  });
