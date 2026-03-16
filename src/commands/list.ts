import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { readGlobalConfig, readIndexConfig } from "../lib/index/index-config";
import { gracefulExit } from "../lib/utils/exit";
import { listProjects } from "../lib/utils/project-registry";
import { ensureProjectPaths, findProjectRoot } from "../lib/utils/project-root";

const style = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function getDirectorySize(dirPath: string): number {
  let totalSize = 0;
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        totalSize += getDirectorySize(itemPath);
      } else {
        totalSize += stats.size;
      }
    }
  } catch {}

  return totalSize;
}

function shortenPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

export const list = new Command("list")
  .description("Show indexed projects")
  .option("--all", "Show all known projects across the system")
  .action(async (options: { all?: boolean }) => {
    if (options.all) {
      await showAllProjects();
    } else {
      await showCurrentProject();
    }
    await gracefulExit();
  });

async function showCurrentProject(): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
  const paths = ensureProjectPaths(projectRoot);

  const entries = [
    { label: "LanceDB", dir: paths.lancedbDir },
    { label: "Cache", dir: paths.cacheDir },
  ];

  console.log(`\n${style.bold("Project")}: ${style.green(projectRoot)}`);
  console.log(`${style.dim("Data directory")}: ${paths.dataDir}\n`);

  const config = readIndexConfig(paths.configPath);
  if (config) {
    console.log(
      `${style.dim("Model")}: ${config.modelTier ?? "small"} (${config.vectorDim ?? 384}d)`,
    );
    console.log(`${style.dim("Mode")}: ${config.embedMode ?? "cpu"}`);
    if (config.indexedAt) {
      console.log(
        `${style.dim("Indexed")}: ${formatDate(new Date(config.indexedAt))}`,
      );
    }
    console.log();
  }

  for (const entry of entries) {
    if (!fs.existsSync(entry.dir)) {
      console.log(`${entry.label}: ${style.dim("not created yet")}`);
      continue;
    }
    const stats = fs.statSync(entry.dir);
    const size = getDirectorySize(entry.dir);
    console.log(
      `${entry.label}: ${style.green(formatSize(size))} ${style.dim(
        `(updated ${formatDate(stats.mtime)})`,
      )}`,
    );
  }
}

async function showAllProjects(): Promise<void> {
  const projects = listProjects();
  const globalConfig = readGlobalConfig();

  if (projects.length === 0) {
    console.log(
      "\nNo projects registered yet. Index a project to see it here.",
    );
    return;
  }

  console.log();

  // Column widths
  const nameWidth = Math.max(8, ...projects.map((p) => p.name.length));
  const pathWidth = Math.max(
    12,
    ...projects.map((p) => shortenPath(p.root).length),
  );

  // Header
  console.log(
    `${style.bold(pad("Project", nameWidth))}  ${style.bold(pad("Path", pathWidth))}  ${style.bold("Dims")}  ${style.bold("Status")}`,
  );

  for (const project of projects) {
    const dimMatch = project.vectorDim === globalConfig.vectorDim;
    const dimsStr = `${project.vectorDim}d`;
    const status = dimMatch
      ? style.green("ok")
      : style.yellow("reindex needed");

    console.log(
      `${pad(project.name, nameWidth)}  ${style.dim(pad(shortenPath(project.root), pathWidth))}  ${pad(dimsStr, 4)}  ${status}`,
    );
  }

  console.log(
    `\n${style.dim("Global config")}: ${globalConfig.modelTier} (${globalConfig.vectorDim}d), ${globalConfig.embedMode}`,
  );

  const needsReindex = projects.filter(
    (p) => p.vectorDim !== globalConfig.vectorDim,
  );
  if (needsReindex.length > 0) {
    console.log(
      style.yellow(
        `\n${needsReindex.length} project(s) need reindexing. Search will auto-reindex on first use.`,
      ),
    );
  }
}
