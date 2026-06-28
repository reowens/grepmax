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
export function getChangedFiles(ref?: string, cwd?: string): string[] {
  const opts = {
    cwd: cwd ?? process.cwd(),
    encoding: "utf-8" as const,
    timeout: 10_000,
  };
  try {
    let output: string;
    if (ref) {
      // Changes between ref and current state (committed + uncommitted)
      output = execFileSync("git", ["diff", "--name-only", ref], opts);
    } else {
      // Uncommitted changes (staged + unstaged)
      const unstaged = execFileSync(
        "git",
        ["diff", "--name-only", "HEAD"],
        opts,
      );
      const staged = execFileSync(
        "git",
        ["diff", "--name-only", "--cached"],
        opts,
      );
      output = unstaged + staged;
    }
    const root = execFileSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      opts,
    ).trim();
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

export interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  isoDate: string;
  relDate: string;
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  numstatLines: { added: number; removed: number; path: string }[];
}

export interface CommitHistoryOpts {
  paths: string[];
  limit: number;
  since?: string;
  from?: string;
  author?: string;
  follow?: boolean;
  cwd?: string;
}

/**
 * Get commit history for one or more paths. When paths.length > 1 (symbol
 * fan-out), git natively dedupes commits across paths. --follow only works
 * with a single path; auto-disabled otherwise.
 */
export function getCommitHistory(opts: CommitHistoryOpts): Commit[] {
  if (opts.paths.length === 0) return [];

  const args = [
    "log",
    "--pretty=format:%x1e%H%x1f%aN%x1f%aI%x1f%ar%x1f%s",
    "--numstat",
  ];
  if (opts.follow && opts.paths.length === 1) args.push("--follow");
  if (opts.limit > 0) args.push(`-n${opts.limit}`);
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.author) args.push(`--author=${opts.author}`);
  if (opts.from) args.push(`${opts.from}..HEAD`);
  args.push("--");
  for (const p of opts.paths) args.push(p);

  const execOpts = {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf-8" as const,
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  };

  let output: string;
  try {
    output = execFileSync("git", args, execOpts);
  } catch {
    return [];
  }

  const records = output.split("\x1e").filter((r) => r.length > 0);
  const commits: Commit[] = [];
  for (const record of records) {
    const lines = record.split("\n");
    if (lines.length === 0) continue;
    const headerFields = lines[0].split("\x1f");
    if (headerFields.length < 5) continue;
    const [hash, author, isoDate, relDate, subject] = headerFields;

    const numstatLines: { added: number; removed: number; path: string }[] = [];
    let insertions = 0;
    let deletions = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      // Binary diffs report '-' for added/removed; treat as 0.
      const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10);
      const removed = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10);
      const path = parts.slice(2).join("\t");
      if (Number.isFinite(added)) insertions += added;
      if (Number.isFinite(removed)) deletions += removed;
      numstatLines.push({
        added: Number.isFinite(added) ? added : 0,
        removed: Number.isFinite(removed) ? removed : 0,
        path,
      });
    }

    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      author,
      isoDate,
      relDate,
      subject,
      filesChanged: numstatLines.length,
      insertions,
      deletions,
      numstatLines,
    });
  }
  return commits;
}

/**
 * Get untracked files (not yet added to git).
 * Returns absolute paths.
 */
export function getUntrackedFiles(cwd?: string): string[] {
  const opts = {
    cwd: cwd ?? process.cwd(),
    encoding: "utf-8" as const,
    timeout: 10_000,
  };
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      opts,
    );
    const root = execFileSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      opts,
    ).trim();
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => path.resolve(root, f));
  } catch {
    return [];
  }
}
