import * as os from "node:os";
import { Command } from "commander";
import { readGlobalConfig } from "../lib/index/index-config";
import { gracefulExit } from "../lib/utils/exit";
import { isLocked } from "../lib/utils/lock";
import { listProjects } from "../lib/utils/project-registry";
import { findProjectRoot } from "../lib/utils/project-root";
import {
  getWatcherForProject,
  listWatchers,
} from "../lib/utils/watcher-store";
import { PATHS } from "../config";

const style = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
};

function shortenPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function formatAge(isoDate: string): string {
  if (!isoDate) return "never";
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function formatChunks(n?: number): string {
  if (!n) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

export const status = new Command("status")
  .description("Show gmax index status for all projects")
  .addHelpText(
    "after",
    `
Examples:
  gmax status              Show status of all indexed projects
`,
  )
  .action(async () => {
    const globalConfig = readGlobalConfig();
    const projects = listProjects();
    listWatchers(); // cleans stale entries as side effect
    const indexing = isLocked(PATHS.globalRoot);
    const currentRoot = findProjectRoot(process.cwd());

    // Header
    console.log(
      `\n${style.bold("gmax")} · ${globalConfig.modelTier} (${globalConfig.vectorDim}d, ${globalConfig.embedMode})${indexing ? style.yellow(" · indexing...") : ""}`,
    );

    if (projects.length === 0) {
      console.log(
        `\nNo projects added yet. Run ${style.cyan("gmax add")} to get started.\n`,
      );
      await gracefulExit();
      return;
    }

    // Column widths
    const nameWidth = Math.max(10, ...projects.map((p) => p.name.length));

    console.log();
    for (const project of projects) {
      const isCurrent = project.root === currentRoot;
      const watcher = getWatcherForProject(project.root);

      // Status column
      let statusStr: string;
      const projectStatus = project.status ?? "indexed";
      if (projectStatus === "pending") {
        statusStr = style.yellow("pending");
      } else if (projectStatus === "error") {
        statusStr = style.red("error");
      } else if (watcher?.status === "syncing") {
        statusStr = style.yellow("indexing");
      } else if (watcher) {
        statusStr = style.green("watching");
      } else {
        statusStr = style.dim("idle");
      }

      // Chunks column
      const chunks = `${formatChunks(project.chunkCount)} chunks`;

      // Age column
      const age = formatAge(project.lastIndexed);

      // Current marker
      const marker = isCurrent ? style.cyan(" ←") : "";

      const name = project.name.padEnd(nameWidth);
      console.log(
        `  ${name}  ${chunks.padEnd(12)}  ${age.padEnd(10)}  ${statusStr}${marker}`,
      );
    }

    if (currentRoot) {
      console.log(
        `\n${style.dim("Current")}: ${shortenPath(currentRoot)}`,
      );
    }

    console.log();
    await gracefulExit();
  });
