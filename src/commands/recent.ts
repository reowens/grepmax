import * as path from "node:path";
import { Command } from "commander";
import { PATHS } from "../config";
import { MetaCache } from "../lib/store/meta-cache";
import { gracefulExit } from "../lib/utils/exit";
import { findProjectRoot } from "../lib/utils/project-root";

function formatTimeAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export const recent = new Command("recent")
  .description("Show recently modified indexed files")
  .option("-l, --limit <n>", "Max files (default 20)", "20")
  .option("--root <dir>", "Project root (defaults to current directory)")
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
          return;
        }

        const now = Date.now();
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
