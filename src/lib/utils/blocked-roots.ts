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
