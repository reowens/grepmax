import * as fs from "node:fs";
import * as path from "node:path";
import { pathNotStartsWith, pathStartsWith } from "./filter-builder";
import { resolveContainedPath } from "./path-containment";

export interface ScopeOptions {
  projectRoot: string;
  /** Directory that relative --in/--exclude subpaths resolve against.
   *  Defaults to projectRoot. Set to a nested git root when the cwd sits in
   *  a subrepo of a registered umbrella project, so `--in src` means the
   *  subrepo's src/. A base-relative path that doesn't exist falls back to
   *  projectRoot-relative when that one does (e.g. `--in other-subrepo`
   *  from inside a sibling). Containment is always enforced against
   *  projectRoot. */
  base?: string;
  in?: string | string[];
  exclude?: string | string[];
}

export interface ResolvedScope {
  /** Single base path scope. Equals projectRoot/ when no --in is supplied,
   *  or projectRoot/<in>/ when exactly one --in is given. Multi-`--in` keeps
   *  this at projectRoot/ and uses inPrefixes for the OR clause. */
  pathPrefix: string;
  /** All --in values resolved to absolute prefixes; empty when --in collapses
   *  into pathPrefix. */
  inPrefixes: string[];
  /** All --exclude values resolved to absolute prefixes. */
  excludePrefixes: string[];
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const arr = Array.isArray(value) ? value : [value];
  // Support comma-separated values within each occurrence so agents can pass
  // either `--in a --in b` or `--in a,b` interchangeably.
  return arr
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

function joinSubpath(projectRoot: string, base: string, sub: string): string {
  let candidate = path.isAbsolute(sub) ? sub : path.resolve(base, sub);
  if (
    !path.isAbsolute(sub) &&
    path.resolve(base) !== path.resolve(projectRoot) &&
    !fs.existsSync(candidate) &&
    fs.existsSync(path.resolve(projectRoot, sub))
  ) {
    candidate = path.resolve(projectRoot, sub);
  }
  const resolved = resolveContainedPath(projectRoot, candidate);
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

export function resolveScope(opts: ScopeOptions): ResolvedScope {
  const { projectRoot } = opts;
  const base = opts.base ?? projectRoot;
  const ins = toArray(opts.in);
  const excludes = toArray(opts.exclude);

  const projectPrefix = projectRoot.endsWith("/")
    ? projectRoot
    : `${projectRoot}/`;

  const inPrefixesAll = ins.map((v) => joinSubpath(projectRoot, base, v));
  const excludePrefixes = excludes.map((v) =>
    joinSubpath(projectRoot, base, v),
  );

  // Collapse a single --in into pathPrefix to keep WHERE clauses simple.
  if (inPrefixesAll.length === 1) {
    return {
      pathPrefix: inPrefixesAll[0],
      inPrefixes: [],
      excludePrefixes,
    };
  }

  return {
    pathPrefix: projectPrefix,
    inPrefixes: inPrefixesAll,
    excludePrefixes,
  };
}

/**
 * Compose a SQL WHERE clause that AND-applies the resolved scope to an
 * existing condition. Used by symbol commands that build their own table
 * queries (peek/extract/similar/related) instead of going through
 * Searcher.buildWhereClause or GraphBuilder.scopeWhere.
 */
export function buildScopeWhere(
  scope: ResolvedScope,
  condition?: string,
): string {
  const parts: string[] = [];
  if (condition) parts.push(condition);
  parts.push(pathStartsWith(scope.pathPrefix));
  for (const ex of scope.excludePrefixes) {
    parts.push(pathNotStartsWith(ex));
  }
  if (scope.inPrefixes.length > 0) {
    const ors = scope.inPrefixes.map((p) => pathStartsWith(p)).join(" OR ");
    parts.push(`(${ors})`);
  }
  return parts.join(" AND ");
}
