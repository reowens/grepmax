import * as fs from "node:fs";
import * as path from "node:path";

export class PathContainmentError extends Error {
  readonly code = "PATH_OUTSIDE_PROJECT";

  constructor(
    readonly root: string,
    readonly candidate: string,
  ) {
    super(`Path is outside project root: ${candidate}`);
    this.name = "PathContainmentError";
  }
}

function isWithinResolved(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function isPathWithin(root: string, candidate: string): boolean {
  return isWithinResolved(path.resolve(root), path.resolve(candidate));
}

function canonicalizeExistingPath(candidate: string): string {
  let existing = candidate;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return candidate;
    existing = parent;
  }

  const canonicalExisting = fs.realpathSync(existing);
  const remainder = path.relative(existing, candidate);
  return path.resolve(canonicalExisting, remainder);
}

export function resolveContainedPath(
  root: string,
  input: string,
  options: { allowRoot?: boolean; verifyExistingTarget?: boolean } = {},
): string {
  if (input.includes("\0")) {
    throw new PathContainmentError(path.resolve(root), input);
  }

  const resolvedRoot = path.resolve(root);
  const candidate = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(resolvedRoot, input);

  if (
    !isWithinResolved(resolvedRoot, candidate) ||
    (options.allowRoot === false && candidate === resolvedRoot)
  ) {
    throw new PathContainmentError(resolvedRoot, candidate);
  }

  if (options.verifyExistingTarget) {
    const canonicalRoot = fs.realpathSync(resolvedRoot);
    const canonicalCandidate = canonicalizeExistingPath(candidate);
    if (!isWithinResolved(canonicalRoot, canonicalCandidate)) {
      throw new PathContainmentError(resolvedRoot, candidate);
    }
  }

  return candidate;
}

/**
 * Resolve a target that may be cwd-relative or root-relative, preferring an
 * existing cwd-relative match — what a caller sitting in a subdirectory (or
 * a nested subrepo of an umbrella project) means by the path. A candidate
 * that exists but lies outside the root is skipped so the root-relative
 * interpretation can still win. Returns null when no contained candidate
 * exists; with onOutside: "throw", an existing-but-outside match raises
 * PathContainmentError instead (for callers that must loudly reject it).
 */
export function resolveContainedExistingPath(
  root: string,
  target: string,
  options: { cwd?: string; onOutside?: "skip" | "throw" } = {},
): string | null {
  const cwd = options.cwd ?? process.cwd();
  const candidates = [
    path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target),
    path.resolve(root, target),
  ];
  let outside: PathContainmentError | null = null;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return resolveContainedPath(root, candidate, {
        verifyExistingTarget: true,
      });
    } catch (err) {
      if (err instanceof PathContainmentError) {
        outside ??= err;
        continue;
      }
      throw err;
    }
  }
  if (options.onOutside === "throw" && outside) throw outside;
  return null;
}

/** Resolve an existing regular file and return its canonical, contained path. */
export function resolveContainedFile(root: string, input: string): string {
  const candidate = resolveContainedPath(root, input);
  const resolvedRoot = path.resolve(root);
  const canonicalRoot = fs.realpathSync(resolvedRoot);
  const canonicalCandidate = fs.realpathSync(candidate);

  if (
    !isWithinResolved(canonicalRoot, canonicalCandidate) ||
    !fs.statSync(canonicalCandidate).isFile()
  ) {
    throw new PathContainmentError(resolvedRoot, candidate);
  }

  return canonicalCandidate;
}
