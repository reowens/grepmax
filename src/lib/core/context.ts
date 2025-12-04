import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { ensureProjectPaths } from "../utils/project-root";
import { VectorDB } from "../store/vector-db";

export interface ScannerOptions {
  ignorePatterns: string[];
}

export async function createStore(projectRoot = process.cwd()): Promise<VectorDB> {
  const paths = ensureProjectPaths(projectRoot);
  return new VectorDB(paths.lancedbDir);
}

export function createFileSystem(
  options: ScannerOptions = { ignorePatterns: [] },
) {
  const filter = ignore();
  filter.add(options.ignorePatterns ?? []);

  return {
    loadOsgrepignore(root: string) {
      const ignorePath = path.join(root, ".osgrepignore");
      if (fs.existsSync(ignorePath)) {
        filter.add(fs.readFileSync(ignorePath, "utf-8"));
      }
    },
    isIgnored(filePath: string, root: string) {
      const rel = path.relative(root, filePath).replace(/\\/g, "/");
      return filter.ignores(rel);
    },
    async *getFiles(root: string) {
      for await (const entry of fg.stream("**/*", {
        cwd: root,
        onlyFiles: true,
        dot: false,
        followSymbolicLinks: false,
        ignore: options.ignorePatterns,
      })) {
        const rel = entry.toString();
        if (filter.ignores(rel)) continue;
        yield path.join(root, rel);
      }
    },
  };
}
