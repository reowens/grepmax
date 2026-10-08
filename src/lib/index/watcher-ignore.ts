import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as watcher from "@parcel/watcher";
import ignore from "ignore";
import { ProjectFilePolicy } from "./file-policy";

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

const NATIVE_EXCLUSION_LIMIT = 8;
const DISCOVERY_DIRECTORY_LIMIT = 512;
const DISCOVERY_ENTRY_LIMIT = 16384;
const DISCOVERY_DEPTH_LIMIT = 4;
const DISCOVERY_TIME_MS = 1000;

/** FSEvents only receives Parcel's literal paths, not its glob filters. Select
 * bounded, existing directories that file policy already excludes. Never hide
 * a source ancestor merely because some descendants are ignored. */
export async function readNativeWatcherIgnores(
  root: string,
  baseGlobs: readonly string[],
): Promise<Array<string | RegExp>> {
  const policy = new ProjectFilePolicy(root);
  const candidates: Array<{ relative: string; score: number }> = [];
  const discoveryPriority = (directory: string, depth: number) => {
    const parts = path.relative(root, directory).split(path.sep);
    // Package containers often hold nested build roots. Inspect those before
    // descending authored source trees, which can exhaust the entry budget.
    const container = parts.some((part) =>
      ["packages", "apps", "services", "ios", "android", "macos"].includes(
        part,
      ),
    );
    const source = parts.some((part) =>
      ["src", "source", "Sources", "tests", "test", "Tests"].includes(part),
    );
    return (container ? 1000 : 0) - (source ? 2000 : 0) - depth;
  };
  const pending = [{ directory: root, depth: 0 }];
  const deadline = performance.now() + DISCOVERY_TIME_MS;
  let entries = 0;
  let visited = 0;
  for (let cursor = 0; cursor < pending.length; cursor++) {
    if (visited++ >= DISCOVERY_DIRECTORY_LIMIT || performance.now() > deadline)
      break;
    let next = cursor;
    for (let i = cursor + 1; i < pending.length; i++) {
      if (
        discoveryPriority(pending[i].directory, pending[i].depth) >
        discoveryPriority(pending[next].directory, pending[next].depth)
      )
        next = i;
    }
    [pending[cursor], pending[next]] = [pending[next], pending[cursor]];
    const { directory, depth } = pending[cursor];
    try {
      const dir = await fs.opendir(directory);
      for await (const entry of dir) {
        if (++entries > DISCOVERY_ENTRY_LIMIT || performance.now() > deadline)
          break;
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        const classified = await policy.classifyDirectory(absolute);
        if (classified.status === "excluded") {
          if (
            !["default ignore policy", "project ignore policy"].includes(
              classified.reason,
            )
          )
            continue;
          const relative = path
            .relative(root, absolute)
            .split(path.sep)
            .join("/");
          // Public Parcel options distinguish literals from globs. Skip names
          // it could interpret as a pattern; existing glob filtering remains.
          if (!/^[A-Za-z0-9_. /-]+$/.test(relative)) continue;
          const priority =
            entry.name === ".git" || entry.name === "node_modules"
              ? depth === 0
                ? 1000
                : 500
              : entry.name === ".dev"
                ? depth === 0
                  ? 950
                  : 550
                : entry.name === ".build" || entry.name === "DerivedData"
                  ? 800
                  : entry.name === ".next"
                    ? 700
                    : depth === 0
                      ? 600
                      : 200;
          candidates.push({ relative, score: priority - depth * 10 });
        } else if (
          classified.status === "traverse" &&
          depth < DISCOVERY_DEPTH_LIMIT &&
          pending.length < DISCOVERY_DIRECTORY_LIMIT
        ) {
          pending.push({ directory: absolute, depth: depth + 1 });
        }
      }
    } catch {
      // Failed/partial discovery only loses an optimization. Existing glob
      // delivery and authoritative file-policy classification remain in force.
    }
    if (entries >= DISCOVERY_ENTRY_LIMIT) break;
  }
  candidates.sort(
    (a, b) => b.score - a.score || a.relative.localeCompare(b.relative),
  );
  const literalPaths = candidates
    .slice(0, NATIVE_EXCLUSION_LIMIT)
    .map((c) => c.relative);
  return [...literalPaths, ...(await nativeWatcherFilters(root, baseGlobs))];
}

async function nativeWatcherFilters(
  root: string,
  baseGlobs: readonly string[],
) {
  const projectGlobs = await readProjectWatcherIgnores(root);
  return [...baseGlobs, ...projectGlobs].map((pattern) => {
    if (pattern.includes("*")) return pattern;
    // Keep file exclusions and excess directory literals out of ignorePaths:
    // passing more than eight silently defeats macOS stream exclusion.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}(?:/|$)`);
  });
}

async function verifyNativeWatcherIgnores(
  root: string,
  baseGlobs: readonly string[],
  ignores: Array<string | RegExp>,
): Promise<Array<string | RegExp>> {
  const policy = new ProjectFilePolicy(root);
  const literals: string[] = [];
  // Recheck the selected paths, rather than repeating timed discovery. A
  // different partial scan must not cause subscription churn or disable the
  // exclusions we already proved safe. New candidates can wait for refresh.
  for (const pattern of ignores) {
    if (typeof pattern !== "string" || pattern.includes("*")) continue;
    const classified = await policy.classifyDirectory(path.join(root, pattern));
    if (
      classified.status === "excluded" &&
      ["default ignore policy", "project ignore policy"].includes(
        classified.reason,
      )
    )
      literals.push(pattern);
  }
  return [...literals, ...(await nativeWatcherFilters(root, baseGlobs))];
}

export function watcherIgnoreIdentity(ignores: Array<string | RegExp>): string {
  return JSON.stringify(ignores.map((pattern) => String(pattern)));
}

/** A policy edit during subscribe has no event listener yet. Check again after
 * attaching so an old directory exclusion cannot permanently hide newly
 * re-included source. Sustained policy churn falls back to immutable globs. */
export async function subscribeWithNativeExclusions(
  root: string,
  callback: watcher.SubscribeCallback,
  baseGlobs: readonly string[],
  initialIgnores?: Array<string | RegExp>,
): Promise<{ subscription: watcher.AsyncSubscription; policy: string }> {
  let ignores =
    initialIgnores ?? (await readNativeWatcherIgnores(root, baseGlobs));
  for (let attempt = 0; attempt < 2; attempt++) {
    const subscription = await watcher.subscribe(root, callback, {
      ignore: ignores,
    });
    let verified: Array<string | RegExp>;
    try {
      verified = await verifyNativeWatcherIgnores(root, baseGlobs, ignores);
    } catch (error) {
      await subscription.unsubscribe();
      throw error;
    }
    const policy = watcherIgnoreIdentity(ignores);
    if (policy === watcherIgnoreIdentity(verified))
      return { subscription, policy };
    await subscription.unsubscribe();
    ignores = verified;
  }
  const fallback = [...baseGlobs];
  return {
    subscription: await watcher.subscribe(root, callback, { ignore: fallback }),
    policy: watcherIgnoreIdentity(fallback),
  };
}
