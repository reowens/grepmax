import * as fs from "node:fs";
import * as path from "node:path";

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * A project-local `.gmax/lancedb` left by the per-project layout. The central
 * store itself is not one, which matters when the working directory is home.
 */
export function findLegacyProjectIndex(
  cwd: string,
  globalRoot: string,
): string | null {
  const dir = path.join(cwd, ".gmax");
  if (!fs.existsSync(path.join(dir, "lancedb"))) return null;
  if (realpathOrSelf(dir) === realpathOrSelf(globalRoot)) return null;
  return dir;
}
