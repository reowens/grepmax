import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export function isWorktree(dir: string): boolean {
  const gitPath = path.join(dir, ".git");
  try {
    const stats = fs.statSync(gitPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

export function getGitCommonDir(worktreeRoot: string): string | null {
  const gitPath = path.join(worktreeRoot, ".git");
  try {
    const content = fs.readFileSync(gitPath, "utf-8").trim();
    if (!content.startsWith("gitdir: ")) return null;

    const gitDir = content.slice(8).trim();
    const absGitDir = path.resolve(worktreeRoot, gitDir);

    const commonDirFile = path.join(absGitDir, "commondir");
    if (fs.existsSync(commonDirFile)) {
      const commonPath = fs.readFileSync(commonDirFile, "utf-8").trim();
      return path.resolve(absGitDir, commonPath);
    }

    // Fallback: assume standard structure
    return path.resolve(absGitDir, "../../");
  } catch {
    return null;
  }
}

/**
 * Resolves the main repository root from a worktree root.
 */
export function getMainRepoRoot(worktreeRoot: string): string | null {
  if (!isWorktree(worktreeRoot)) return null;

  const commonDir = getGitCommonDir(worktreeRoot);
  if (!commonDir) return null;

  // The common dir is usually .git inside the main repo root.
  // So the main repo root is the parent of commonDir.
  return path.dirname(commonDir);
}

/**
 * Get files changed relative to a git ref (or uncommitted changes if no ref).
 * Returns absolute paths. Includes both staged and unstaged changes.
 */
export function getChangedFiles(
  ref?: string,
  cwd?: string,
): string[] {
  const opts = { cwd: cwd ?? process.cwd(), encoding: "utf-8" as const, timeout: 10_000 };
  try {
    let output: string;
    if (ref) {
      // Changes between ref and current state (committed + uncommitted)
      output = execFileSync("git", ["diff", "--name-only", ref], opts);
    } else {
      // Uncommitted changes (staged + unstaged)
      const unstaged = execFileSync("git", ["diff", "--name-only", "HEAD"], opts);
      const staged = execFileSync("git", ["diff", "--name-only", "--cached"], opts);
      output = unstaged + staged;
    }
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], opts).trim();
    return [
      ...new Set(
        output
          .split("\n")
          .map((f) => f.trim())
          .filter(Boolean)
          .map((f) => path.resolve(root, f)),
      ),
    ];
  } catch {
    return [];
  }
}

/**
 * Get untracked files (not yet added to git).
 * Returns absolute paths.
 */
export function getUntrackedFiles(cwd?: string): string[] {
  const opts = { cwd: cwd ?? process.cwd(), encoding: "utf-8" as const, timeout: 10_000 };
  try {
    const output = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], opts);
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], opts).trim();
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => path.resolve(root, f));
  } catch {
    return [];
  }
}
