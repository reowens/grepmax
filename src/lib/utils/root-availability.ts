import * as fs from "node:fs";

/**
 * Why a project root is not readable right now.
 *
 * - `present`     — the directory exists
 * - `unavailable` — the volume it lives on is not mounted (external drive
 *                   unplugged, network share down). The project is fine; we
 *                   simply cannot see it. Reconnecting restores it.
 * - `missing`     — the volume IS mounted and the directory is genuinely gone
 *
 * The distinction matters because `existsSync` collapses both failure cases
 * into "not found", and acting on that inference destroys state: deregistering
 * a project only drops its registry entry, so its vectors stay in the shared
 * table with no owning project — invisible to every coherence check, which all
 * iterate the registry — and plugging the drive back in does not bring it back.
 */
export type RootAvailability = "present" | "unavailable" | "missing";

/**
 * Directories that hold mount points rather than user data, with how many path
 * segments below them the mount point itself sits.
 *
 * `mountDepth` errs high where a platform is ambiguous (Linux uses both
 * `/media/<volume>` and `/media/<user>/<volume>`). Overshooting biases the
 * classifier toward `unavailable`, which is the safe direction: a wrong
 * `unavailable` only means we decline to auto-remove a genuinely dead project,
 * while a wrong `missing` silently deregisters a live one.
 */
const MOUNT_CONTAINERS: ReadonlyArray<{ prefix: string; mountDepth: number }> =
  [
    { prefix: "/Volumes", mountDepth: 1 }, // macOS
    { prefix: "/run/media", mountDepth: 2 }, // Linux, udisks2
    { prefix: "/media", mountDepth: 2 },
    { prefix: "/mnt", mountDepth: 1 },
    { prefix: "/net", mountDepth: 1 }, // autofs network mounts
  ];

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    // A disconnected network mount can throw EIO/ETIMEDOUT rather than ENOENT.
    // Either way the path is not readable, and the caller's container check
    // decides whether that means unavailable or missing.
    return false;
  }
}

/**
 * Classify a project root that may live on removable or network storage.
 *
 * Longest matching container wins, so `/run/media` is not shadowed by `/media`.
 */
export function classifyRoot(root: string): RootAvailability {
  if (exists(root)) return "present";

  const container = MOUNT_CONTAINERS.filter(
    (c) => root === c.prefix || root.startsWith(`${c.prefix}/`),
  ).sort((a, b) => b.prefix.length - a.prefix.length)[0];

  if (!container) return "missing";

  // The mount point is the container plus `mountDepth` segments. If it is
  // absent, nothing is mounted there and the project is merely out of reach.
  const rest = root.slice(container.prefix.length).split("/").filter(Boolean);
  if (rest.length < container.mountDepth) return "missing";
  const mountPoint = `${container.prefix}/${rest.slice(0, container.mountDepth).join("/")}`;

  return exists(mountPoint) ? "missing" : "unavailable";
}

/**
 * True when the root is absent only because its volume is not mounted.
 * Callers that delete or rewrite persistent state must check this first.
 */
export function isRootUnavailable(root: string): boolean {
  return classifyRoot(root) === "unavailable";
}

/** Human-readable reason for a non-present root, for logs and doctor output. */
export function describeRoot(root: string): string {
  switch (classifyRoot(root)) {
    case "present":
      return "available";
    case "unavailable":
      return "volume not mounted";
    case "missing":
      return "directory not found";
  }
}
