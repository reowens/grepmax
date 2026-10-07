import * as fs from "node:fs/promises";
import * as path from "node:path";
import ignore from "ignore";

/** Only the common positive gitignore/glob subset is safe to push into Parcel.
 * Negations, escapes and unsupported syntax stay with ProjectFilePolicy, so a
 * native ignore can never hide a file that an explicit re-inclusion needs. */
export function nativeProjectIgnoreGlobs(content: string): string[] {
  const lines = content
    .split("\n")
    .map((line) => line.replace(/\r$/, "").replace(/ +$/, ""));
  if (lines.some((line) => line.startsWith("!"))) return [];
  const result = new Set<string>();
  for (const line of lines) {
    if (!line || line.startsWith("#") || !/^[A-Za-z0-9_.*/-]+$/.test(line))
      continue;
    const pattern = line.replace(/^\//, "").replace(/\/$/, "");
    if (
      !pattern ||
      pattern.split("/").some((part) => part === "." || part === "..")
    )
      continue;
    // Keep root policy changes observable, including removal of a blanket rule.
    const filter = ignore().add(line);
    if (filter.ignores(".gmaxignore") || filter.ignores(".gitignore")) continue;
    if (pattern.split("/").some((part) => part.includes("**") && part !== "**"))
      continue;
    const glob =
      line.startsWith("/") || pattern.includes("/") ? pattern : `**/${pattern}`;
    // A trailing slash ignores directories, never a same-named source file.
    if (!line.endsWith("/")) result.add(glob);
    result.add(`${glob}/**`);
  }
  return [...result];
}

/** Root .gmaxignore rules are explicit project choices. Nested scopes and
 * .gitignore remain authoritative in file policy, without lossy translation. */
export async function readProjectWatcherIgnores(
  root: string,
): Promise<string[]> {
  try {
    const file = path.join(root, ".gmaxignore");
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 65536) return [];
    const contents = await fs.readFile(file, "utf8");
    if (Buffer.byteLength(contents) > 65536) return [];
    return nativeProjectIgnoreGlobs(contents);
  } catch {
    // File policy handles unreadable policy conservatively. Native watching
    // must still deliver changes rather than treating a failed read as empty.
    return [];
  }
}
