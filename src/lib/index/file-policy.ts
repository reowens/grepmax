import type { Stats } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import ignore, { type Ignore } from "ignore";
import { MAX_FILE_SIZE_BYTES } from "../../config";
import { isIndexableFile } from "../utils/file-utils";
import { isPathWithin } from "../utils/path-containment";
import { DEFAULT_IGNORE_PATTERNS } from "./ignore-patterns";

export type FilePolicyResult =
  | { status: "indexable"; stat: Stats }
  | { status: "excluded"; reason: string }
  | { status: "missing" }
  | { status: "error"; error: unknown; protectedPath: string };

export type DirectoryPolicyResult =
  | { status: "traverse" }
  | { status: "excluded"; reason: string }
  | { status: "missing" }
  | { status: "error"; error: unknown; protectedPath: string };

type IgnoreScope = { dir: string; filter: Ignore | null };

export class IgnorePolicyReadError extends Error {
  constructor(
    readonly protectedPath: string,
    readonly cause: unknown,
  ) {
    super(`Unable to read ignore policy under ${protectedPath}`);
    this.name = "IgnorePolicyReadError";
  }
}

export class ProjectFilePolicy {
  readonly projectRoot: string;
  private canonicalRoot: string | null;
  private readonly rootFilter: Ignore;
  private readonly ignoreFiles: string[];
  private readonly ignoreCache = new Map<string, Promise<IgnoreScope>>();

  constructor(
    projectRoot: string,
    options: { additionalPatterns?: string[]; ignoreFiles?: string[] } = {},
  ) {
    this.projectRoot = path.resolve(projectRoot);
    try {
      this.canonicalRoot = fs.realpathSync(this.projectRoot);
    } catch {
      // Root availability is classified by the walker. Construction must not
      // turn a transient mount/root failure into a permanently wedged watcher.
      this.canonicalRoot = null;
    }
    this.ignoreFiles = options.ignoreFiles ?? [".gitignore", ".gmaxignore"];
    this.rootFilter = ignore().add([
      ...DEFAULT_IGNORE_PATTERNS,
      ".git",
      ".gmax",
      ...(options.additionalPatterns ?? []),
    ]);
  }

  isPolicyFile(absPath: string): boolean {
    return this.ignoreFiles.includes(path.basename(absPath));
  }

  invalidateIgnoreCache(): void {
    this.ignoreCache.clear();
  }

  isLexicallyContained(absPath: string): boolean {
    return isPathWithin(this.projectRoot, path.resolve(absPath));
  }

  normalizeEventPath(absPath: string): string | null {
    const resolved = path.resolve(absPath);
    if (this.isLexicallyContained(resolved)) return resolved;
    if (!this.canonicalRoot || !isPathWithin(this.canonicalRoot, resolved)) {
      return null;
    }
    return path.resolve(
      this.projectRoot,
      path.relative(this.canonicalRoot, resolved),
    );
  }

  private relative(absPath: string): string {
    return path.relative(this.projectRoot, absPath).split(path.sep).join("/");
  }

  private async loadIgnoreScope(dir: string): Promise<IgnoreScope> {
    const existing = this.ignoreCache.get(dir);
    if (existing) return existing;
    const pending = (async () => {
      let filter: Ignore | null = null;
      for (const fileName of this.ignoreFiles) {
        try {
          const content = await fs.promises.readFile(
            path.join(dir, fileName),
            "utf8",
          );
          if (!filter) filter = ignore();
          filter.add(content);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new IgnorePolicyReadError(dir, err);
          }
        }
      }
      return { dir, filter };
    })();
    this.ignoreCache.set(dir, pending);
    void pending.catch(() => {
      if (this.ignoreCache.get(dir) === pending) this.ignoreCache.delete(dir);
    });
    return pending;
  }

  private scopeDirectories(throughDir: string): string[] {
    const relative = path.relative(this.projectRoot, throughDir);
    if (!relative) return [this.projectRoot];
    const parts = relative.split(path.sep).filter(Boolean);
    const dirs = [this.projectRoot];
    let current = this.projectRoot;
    for (const part of parts) {
      current = path.join(current, part);
      dirs.push(current);
    }
    return dirs;
  }

  private async classifyPath(
    absPath: string,
  ): Promise<
    | { status: "present"; stat: Stats; resolved: string }
    | { status: "excluded"; reason: string }
    | { status: "missing" }
    | { status: "error"; error: unknown; protectedPath: string }
  > {
    const resolved = path.resolve(absPath);
    if (!this.isLexicallyContained(resolved)) {
      return { status: "excluded", reason: "outside project root" };
    }
    try {
      const stat = await fs.promises.lstat(resolved);
      const isRoot = resolved === this.projectRoot;
      if (stat.isSymbolicLink() && !isRoot) {
        return { status: "excluded", reason: "symbolic link" };
      }
      const canonical = await fs.promises.realpath(resolved);
      if (!this.canonicalRoot) {
        this.canonicalRoot = await fs.promises.realpath(this.projectRoot);
      }
      const expected = path.resolve(
        this.canonicalRoot,
        path.relative(this.projectRoot, resolved),
      );
      if (canonical !== expected) {
        return { status: "excluded", reason: "symlinked ancestor" };
      }
      return {
        status: "present",
        stat:
          isRoot && stat.isSymbolicLink()
            ? await fs.promises.stat(resolved)
            : stat,
        resolved,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "missing" };
      }
      return { status: "error", error: err, protectedPath: resolved };
    }
  }

  private async ignoredByPolicy(
    absPath: string,
    isDirectory: boolean,
    loadThroughDir: string,
    includeLastScope: boolean,
  ): Promise<string | null> {
    const rootRelative = this.relative(absPath);
    const rootTest = isDirectory ? `${rootRelative}/` : rootRelative;
    if (rootRelative && this.rootFilter.ignores(rootTest)) {
      return "default ignore policy";
    }

    const dirs = this.scopeDirectories(loadThroughDir);
    const scopes = await Promise.all(
      dirs.map((dir) => this.loadIgnoreScope(dir)),
    );
    const applicable = includeLastScope ? scopes : scopes.slice(0, -1);
    for (const scope of applicable) {
      if (!scope.filter) continue;
      const relative = path
        .relative(scope.dir, absPath)
        .split(path.sep)
        .join("/");
      if (!relative) continue;
      const testPath = isDirectory ? `${relative}/` : relative;
      if (scope.filter.ignores(testPath)) return "project ignore policy";
    }
    return null;
  }

  async classifyFile(absPath: string): Promise<FilePolicyResult> {
    if (this.isPolicyFile(absPath)) {
      return { status: "excluded", reason: "ignore policy file" };
    }
    const classified = await this.classifyPath(absPath);
    if (classified.status !== "present") return classified;
    if (!classified.stat.isFile()) {
      return { status: "excluded", reason: "not a regular file" };
    }
    try {
      const ignored = await this.ignoredByPolicy(
        classified.resolved,
        false,
        path.dirname(classified.resolved),
        true,
      );
      if (ignored) return { status: "excluded", reason: ignored };
    } catch (error) {
      return {
        status: "error",
        error,
        protectedPath:
          error instanceof IgnorePolicyReadError
            ? error.protectedPath
            : path.dirname(classified.resolved),
      };
    }
    if (!isIndexableFile(classified.resolved, classified.stat.size)) {
      return { status: "excluded", reason: "non-indexable file" };
    }
    if (
      classified.stat.size === 0 ||
      classified.stat.size > MAX_FILE_SIZE_BYTES
    ) {
      return { status: "excluded", reason: "invalid file size" };
    }
    return { status: "indexable", stat: classified.stat };
  }

  async classifyDirectory(absPath: string): Promise<DirectoryPolicyResult> {
    const classified = await this.classifyPath(absPath);
    if (classified.status !== "present") return classified;
    if (!classified.stat.isDirectory()) {
      return { status: "excluded", reason: "not a directory" };
    }
    try {
      const ignored = await this.ignoredByPolicy(
        classified.resolved,
        true,
        classified.resolved,
        false,
      );
      if (ignored) return { status: "excluded", reason: ignored };
    } catch (error) {
      return {
        status: "error",
        error,
        protectedPath:
          error instanceof IgnorePolicyReadError
            ? error.protectedPath
            : classified.resolved,
      };
    }
    return { status: "traverse" };
  }
}
