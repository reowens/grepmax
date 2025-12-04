import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectPaths {
  root: string;
  osgrepDir: string;
  lancedbDir: string;
  cacheDir: string;
  lmdbPath: string;
  configPath: string;
}

export function findProjectRoot(startDir = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".osgrep"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

export function ensureProjectPaths(startDir = process.cwd()): ProjectPaths {
  const root = findProjectRoot(startDir) ?? path.resolve(startDir);
  const osgrepDir = path.join(root, ".osgrep");
  const lancedbDir = path.join(osgrepDir, "lancedb");
  const cacheDir = path.join(osgrepDir, "cache");
  const lmdbPath = path.join(cacheDir, "meta.lmdb");
  const configPath = path.join(osgrepDir, "config.json");

  [osgrepDir, lancedbDir, cacheDir].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });

  return { root, osgrepDir, lancedbDir, cacheDir, lmdbPath, configPath };
}
