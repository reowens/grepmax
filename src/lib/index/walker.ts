import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPathWithin } from "../utils/path-containment";
import { type DirectoryPolicyResult, ProjectFilePolicy } from "./file-policy";

export interface WalkState {
  rootComplete: boolean;
  protectedPaths: Set<string>;
  errors: Array<{ path: string; error: unknown }>;
}

export function createWalkState(): WalkState {
  return { rootComplete: true, protectedPaths: new Set(), errors: [] };
}

export function isPathProtectedByWalkState(
  candidate: string,
  state: WalkState,
): boolean {
  if (!state.rootComplete) return true;
  return Array.from(state.protectedPaths).some((protectedPath) =>
    isPathWithin(protectedPath, candidate),
  );
}

interface WalkOptions {
  ignoreFiles?: string[];
  additionalPatterns?: string[];
  policy?: ProjectFilePolicy;
  state?: WalkState;
}

export async function* walk(
  rootDir: string,
  options: WalkOptions = {},
): AsyncGenerator<string> {
  const root = path.resolve(rootDir);
  const policy =
    options.policy ??
    new ProjectFilePolicy(root, {
      ignoreFiles: options.ignoreFiles,
      additionalPatterns: options.additionalPatterns,
    });
  const state = options.state ?? createWalkState();
  yield* walkDirectory(root, root, policy, state, true);
}

async function* walkDirectory(
  currentDir: string,
  rootDir: string,
  policy: ProjectFilePolicy,
  state: WalkState,
  isRoot: boolean,
): AsyncGenerator<string> {
  const directory = await policy.classifyDirectory(currentDir);
  if (directory.status === "error") {
    state.protectedPaths.add(directory.protectedPath);
    state.errors.push({
      path: directory.protectedPath,
      error: directory.error,
    });
    if (isRoot) state.rootComplete = false;
    return;
  }
  if (directory.status !== "traverse") {
    if (isRoot) state.rootComplete = false;
    return;
  }

  let entries: Dirent[];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    state.protectedPaths.add(currentDir);
    state.errors.push({ path: currentDir, error });
    if (isRoot) state.rootComplete = false;
    return;
  }

  for (const entry of entries) {
    const absPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDirectory(absPath, rootDir, policy, state, false);
      continue;
    }
    if (!entry.isFile()) {
      try {
        const stat = await fs.lstat(absPath);
        if (stat.isDirectory()) {
          yield* walkDirectory(absPath, rootDir, policy, state, false);
          continue;
        }
        if (!stat.isFile()) continue;
      } catch (error) {
        state.protectedPaths.add(absPath);
        state.errors.push({ path: absPath, error });
        continue;
      }
    }
    const file = await policy.classifyFile(absPath);
    if (file.status === "indexable") {
      yield path.relative(rootDir, absPath);
    } else if (file.status === "error") {
      state.protectedPaths.add(file.protectedPath);
      state.errors.push({ path: file.protectedPath, error: file.error });
    }
  }
}

export interface WalkedDirectory {
  path: string;
  depth: number;
  result: DirectoryPolicyResult;
}

/** Every directory the walk classifies, in name order. A directory is
 * entered only when policy says traverse, exactly as `walk` does. */
export async function* walkDirectories(
  rootDir: string,
  policy: ProjectFilePolicy,
): AsyncGenerator<WalkedDirectory> {
  yield* walkDirectoryTree(path.resolve(rootDir), 0, policy);
}

async function* walkDirectoryTree(
  directory: string,
  depth: number,
  policy: ProjectFilePolicy,
): AsyncGenerator<WalkedDirectory> {
  const result = await policy.classifyDirectory(directory);
  yield { path: directory, depth, result };
  if (result.status !== "traverse") return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names)
    yield* walkDirectoryTree(path.join(directory, name), depth + 1, policy);
}
