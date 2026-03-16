import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";

export interface ProjectPaths {
  root: string;
  dataDir: string;
  lancedbDir: string;
  cacheDir: string;
  lmdbPath: string;
  configPath: string;
}

export function findProjectRoot(startDir = process.cwd()): string | null {
  const start = path.resolve(startDir);

  // Only consider the current directory; do not climb above the user's cwd.
  const dataDir = path.join(start, ".gmax");
  const gitDir = path.join(start, ".git");
  if (
    (fs.existsSync(dataDir) || fs.existsSync(gitDir)) &&
    path.resolve(start) !== path.resolve(PATHS.globalRoot)
  ) {
    return start;
  }

  // Otherwise, treat the current dir as the root (per-subdirectory isolation).
  return start;
}

export function ensureProjectPaths(
  startDir = process.cwd(),
  options?: { dryRun?: boolean },
): ProjectPaths {
  const root = findProjectRoot(startDir) ?? path.resolve(startDir);
  const dataDir = path.join(root, ".gmax");
  const lancedbDir = path.join(dataDir, "lancedb");
  const cacheDir = path.join(dataDir, "cache");
  const lmdbPath = path.join(cacheDir, "meta.lmdb");
  const configPath = path.join(dataDir, "config.json");

  if (!options?.dryRun) {
    [dataDir, lancedbDir, cacheDir].forEach((dir) => {
      fs.mkdirSync(dir, { recursive: true });
    });

    ensureGitignoreEntry(root);
  }

  return { root, dataDir, lancedbDir, cacheDir, lmdbPath, configPath };
}

function fileContainsEntry(filePath: string, entry: string): boolean {
  try {
    const contents = fs.readFileSync(filePath, "utf-8");
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .includes(entry);
  } catch {
    return false;
  }
}

function ensureGitignoreEntry(root: string) {
  // Only add when inside a git repo.
  if (!fs.existsSync(path.join(root, ".git"))) return;

  const entry = ".gmax";

  // Check .git/info/exclude first
  const excludePath = path.join(root, ".git", "info", "exclude");
  if (fileContainsEntry(excludePath, entry)) return;

  // Check .gitignore
  const gitignorePath = path.join(root, ".gitignore");
  if (fileContainsEntry(gitignorePath, entry)) return;

  // Add to .gitignore
  let contents = "";
  try {
    contents = fs.readFileSync(gitignorePath, "utf-8");
  } catch {
    // ignore missing file; will create below
  }

  const needsNewline = contents.length > 0 && !contents.endsWith("\n");
  const prefix = needsNewline ? "\n" : "";
  fs.writeFileSync(gitignorePath, `${contents}${prefix}${entry}\n`, {
    encoding: "utf-8",
  });
}
