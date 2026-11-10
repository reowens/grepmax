import * as path from "node:path";
import * as watcher from "@parcel/watcher";
import ignore from "ignore";
import { ProjectFilePolicy, ROOT_IGNORE_PATTERNS } from "./file-policy";
import { walkDirectories } from "./walker";

/** Only the common positive gitignore/glob subset is safe to push into Parcel.
 * Negations, escapes and unsupported syntax stay with ProjectFilePolicy, so a
 * native ignore can never hide a file that an explicit re-inclusion needs.
 * `scope` is the folder the rules came from, relative to the watch root. */
export function nativeProjectIgnoreGlobs(
  content: string,
  scope = "",
): string[] {
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
    // Keep policy changes observable, including removal of a blanket rule.
    const filter = ignore().add(line);
    if (filter.ignores(".gmaxignore") || filter.ignores(".gitignore")) continue;
    if (pattern.split("/").some((part) => part.includes("**") && part !== "**"))
      continue;
    const anchored = line.startsWith("/") || pattern.includes("/");
    const glob = [scope, anchored ? pattern : `**/${pattern}`]
      .filter(Boolean)
      .join("/");
    // A trailing slash ignores directories, never a same-named source file.
    if (!line.endsWith("/")) result.add(glob);
    result.add(`${glob}/**`);
  }
  return [...result];
}

/** The default policy as Parcel globs, plus atomic-save temp files named
 * `.!<pid>!<name>`, which no policy rule can spell. */
export const WATCHER_IGNORE_GLOBS: string[] = [
  ...nativeProjectIgnoreGlobs(ROOT_IGNORE_PATTERNS.join("\n")),
  "**/.!*!*",
];

// FSEvents honours at most 8 literal exclusion paths; more silently disables
// them all. Linux has no such limit.
const NATIVE_EXCLUSION_LIMIT = 8;
// Folder names Parcel could read as a pattern, in a literal or a scope prefix.
const PLAIN_PATH = /^[A-Za-z0-9_. /-]+$/;
const POLICY_REASONS = ["default ignore policy", "project ignore policy"];

function literalPriority(name: string, depth: number): number {
  const base =
    name === ".git" || name === "node_modules"
      ? depth === 0
        ? 1000
        : 500
      : name === ".dev"
        ? depth === 0
          ? 950
          : 550
        : name === ".build" || name === "DerivedData"
          ? 800
          : name === ".next"
            ? 700
            : depth === 0
              ? 600
              : 200;
  return base - depth * 10;
}

/** The subscription's ignore set, from the same policy the indexer walks:
 * default patterns, then every traversed folder's .gitignore and .gmaxignore
 * rules scoped to that folder. Excluded folders also become literal paths, so
 * a folder whose rules could not be translated (a negation in its scope) is
 * still left unwatched: on macOS the 8 noisiest, on Linux every one that a
 * policy file excludes (the default globs already cover the rest). */
export async function readNativeWatcherIgnores(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Array<string | RegExp>> {
  const policy = new ProjectFilePolicy(root);
  const globs: string[] = [];
  const literals: Array<{ relative: string; score: number }> = [];
  const projectExcluded = new Set<string>();
  for await (const directory of walkDirectories(root, policy)) {
    const relative = path
      .relative(root, directory.path)
      .split(path.sep)
      .join("/");
    if (relative && !PLAIN_PATH.test(relative)) continue;
    const { result } = directory;
    if (result.status === "traverse") {
      const rules = await policy.ignoreRules(directory.path).catch(() => "");
      globs.push(...nativeProjectIgnoreGlobs(rules, relative));
    } else if (
      result.status === "excluded" &&
      POLICY_REASONS.includes(result.reason)
    ) {
      if (result.reason === "project ignore policy")
        projectExcluded.add(relative);
      literals.push({
        relative,
        score: literalPriority(
          path.basename(directory.path),
          directory.depth - 1,
        ),
      });
    }
  }
  if (platform !== "darwin")
    return [
      ...literals
        .filter((l) => projectExcluded.has(l.relative))
        .map((l) => l.relative),
      ...nativeWatcherFilters(globs),
    ];
  literals.sort(
    (a, b) => b.score - a.score || a.relative.localeCompare(b.relative),
  );
  return [
    ...literals.slice(0, NATIVE_EXCLUSION_LIMIT).map((l) => l.relative),
    ...nativeWatcherFilters(globs),
  ];
}

function nativeWatcherFilters(projectGlobs: readonly string[]) {
  return [...WATCHER_IGNORE_GLOBS, ...projectGlobs].map((pattern) => {
    if (pattern.includes("*")) return pattern;
    // Keep file exclusions and excess directory literals out of ignorePaths:
    // passing more than eight silently defeats macOS stream exclusion.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}(?:/|$)`);
  });
}

async function verifyNativeWatcherIgnores(
  root: string,
  ignores: Array<string | RegExp>,
  platform: NodeJS.Platform,
): Promise<Array<string | RegExp>> {
  const policy = new ProjectFilePolicy(root);
  const literals: string[] = [];
  // Recheck the selected literals rather than choosing again, so a folder
  // created during the crawl cannot cause churn. New candidates wait for the
  // next update. The rules themselves are read again in full.
  for (const pattern of ignores) {
    if (typeof pattern !== "string" || pattern.includes("*")) continue;
    const classified = await policy.classifyDirectory(path.join(root, pattern));
    if (
      classified.status === "excluded" &&
      POLICY_REASONS.includes(classified.reason)
    )
      literals.push(pattern);
  }
  const fresh = await readNativeWatcherIgnores(root, platform);
  return [
    ...literals,
    ...fresh.filter((p) => typeof p !== "string" || p.includes("*")),
  ];
}

export function watcherIgnoreIdentity(ignores: Array<string | RegExp>): string {
  return JSON.stringify(ignores.map((pattern) => String(pattern)));
}

export interface NativeSubscription {
  subscription: watcher.AsyncSubscription;
  /** The ignore set Parcel attached with. */
  policy: string;
  /** The ignore set policy asked for. It differs from `policy` only after the
   * fallback, so an unchanged policy does not subscribe again. */
  wanted: string;
}

/** A policy edit during subscribe has no event listener yet. Check again after
 * attaching so an old directory exclusion cannot permanently hide newly
 * re-included source. Sustained policy churn falls back to the default globs,
 * which hide only what no policy file can re-include. */
export async function subscribeWithNativeExclusions(
  root: string,
  callback: watcher.SubscribeCallback,
  initialIgnores?: Array<string | RegExp>,
  platform: NodeJS.Platform = process.platform,
): Promise<NativeSubscription> {
  let ignores =
    initialIgnores ?? (await readNativeWatcherIgnores(root, platform));
  for (let attempt = 0; attempt < 2; attempt++) {
    const subscription = await watcher.subscribe(root, callback, {
      ignore: ignores,
    });
    let verified: Array<string | RegExp>;
    try {
      verified = await verifyNativeWatcherIgnores(root, ignores, platform);
    } catch (error) {
      await subscription.unsubscribe();
      throw error;
    }
    const policy = watcherIgnoreIdentity(ignores);
    if (policy === watcherIgnoreIdentity(verified))
      return { subscription, policy, wanted: policy };
    await subscription.unsubscribe();
    ignores = verified;
  }
  const fallback = [...WATCHER_IGNORE_GLOBS];
  return {
    subscription: await watcher.subscribe(root, callback, { ignore: fallback }),
    policy: watcherIgnoreIdentity(fallback),
    wanted: watcherIgnoreIdentity(ignores),
  };
}
