import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const BLOCKED_ROOTS_DESCRIPTION =
  "home, /, /Users, /tmp, /private, /var, /usr, /opt, /etc, /System, /Library, /Applications";

export function getBlockedProjectRoots(): Set<string> {
  const home = os.homedir();
  return new Set(
    [
      home,
      path.dirname(home),
      "/",
      "/tmp",
      "/private",
      "/private/tmp",
      "/private/var",
      "/var",
      "/usr",
      "/opt",
      "/etc",
      "/System",
      "/Library",
      "/Applications",
    ].map((candidate) => path.resolve(candidate)),
  );
}

export function isBlockedProjectRoot(root: string): boolean {
  return getBlockedProjectRoots().has(path.resolve(root));
}

/**
 * A linked git worktree has a `.git` FILE (not a directory) pointing back into
 * the main repo's `.git/worktrees/<name>`. Indexing one duplicates the whole
 * corpus of the repo it was cut from — three platform worktrees once put 680k
 * duplicate chunks in the index and pinned seven embed workers at ~1GB each.
 */
export function isGitWorktreeRoot(root: string): boolean {
  const gitPath = path.join(path.resolve(root), ".git");
  let contents: string;
  try {
    if (!fs.statSync(gitPath).isFile()) return false;
    contents = fs.readFileSync(gitPath, "utf8");
  } catch {
    return false;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(contents);
  if (!match?.[1]) return false;
  const gitdir = match[1].trim().replace(/\\/g, "/");
  return /(^|\/)\.git\/worktrees\//.test(gitdir);
}

export const WORKTREE_REFUSAL =
  "gmax does not index git worktrees — they duplicate the repository they were cut from. Add the main repository root instead.";
