/**
 * Cross-project search scoping (Phase 6).
 *
 * The shared LanceDB table holds chunks from every indexed project, scoped by
 * absolute-path prefix. Single-project search pins a `pathPrefix`; cross-project
 * search drops the prefix and instead scopes with the `project_roots` /
 * `exclude_project_roots` filter clauses (an OR-group of `path LIKE` prefixes —
 * see buildWhereClause in searcher.ts). This module resolves the CLI flags
 * (`--all-projects` / `--projects` / `--exclude-projects`) to those filter
 * values and groups results back by owning project for display.
 */

import { listProjects, type ProjectEntry } from "./project-registry";

export interface CrossProjectScope {
  /** True when --all-projects or --projects was passed. */
  active: boolean;
  /** Projects in scope (for grouping + labeling results). */
  roots: { root: string; name: string }[];
  /** Exact registered roots allowed in the shared-table query. */
  projectRoots: string[];
  /** CSV of roots → filters.project_roots (set only when narrowing to a subset). */
  projectRootsCsv?: string;
  /** CSV of roots → filters.exclude_project_roots. */
  excludeProjectRootsCsv?: string;
  /** Non-fatal messages (unknown names, etc.) for the caller to surface. */
  warnings: string[];
}

export function resolveCrossProjectScope(opts: {
  allProjects?: boolean;
  projects?: string;
  excludeProjects?: string;
}): CrossProjectScope {
  const active = !!(opts.allProjects || opts.projects);
  if (!active) {
    return { active: false, roots: [], projectRoots: [], warnings: [] };
  }

  // Ignore "error"-status projects: the daemon won't search them anyway.
  const all = listProjects().filter((p) => p.status !== "error");
  const byName = new Map(all.map((p) => [p.name, p]));
  const warnings: string[] = [];

  const resolveNames = (
    csv: string | undefined,
  ): { found: ProjectEntry[]; missing: string[] } => {
    const names = (csv ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const found: ProjectEntry[] = [];
    const missing: string[] = [];
    for (const n of names) {
      const p = byName.get(n);
      if (p) found.push(p);
      else missing.push(n);
    }
    return { found, missing };
  };

  const excluded = resolveNames(opts.excludeProjects);
  const excludedRoots = new Set(excluded.found.map((p) => p.root));
  if (excluded.missing.length) {
    warnings.push(`Unknown --exclude-projects: ${excluded.missing.join(", ")}`);
  }

  let included: ProjectEntry[];
  let projectRootsCsv: string | undefined;
  let excludeProjectRootsCsv: string | undefined;

  if (opts.projects) {
    const r = resolveNames(opts.projects);
    if (r.missing.length) {
      warnings.push(
        `Unknown --projects: ${r.missing.join(", ")}. Available: ${all
          .map((p) => p.name)
          .join(", ")}`,
      );
    }
    included = r.found.filter((p) => !excludedRoots.has(p.root));
    // Narrowed to an explicit subset → scope with project_roots.
    projectRootsCsv = included.length
      ? included.map((p) => p.root).join(",")
      : undefined;
  } else {
    // --all-projects still emits an explicit allow-list. The physical table can
    // contain orphan or failed-project rows that are not eligible here.
    included = all.filter((p) => !excludedRoots.has(p.root));
    projectRootsCsv = included.length
      ? included.map((p) => p.root).join(",")
      : undefined;
    if (excludedRoots.size) {
      excludeProjectRootsCsv = [...excludedRoots].join(",");
    }
  }

  return {
    active: true,
    roots: included.map((p) => ({ root: p.root, name: p.name })),
    projectRoots: included.map((p) => p.root),
    projectRootsCsv,
    excludeProjectRootsCsv,
    warnings,
  };
}

/** Longest-prefix match of an absolute path against the in-scope project roots. */
export function projectForPath(
  absPath: string,
  roots: { root: string; name: string }[],
): { root: string; name: string } | null {
  let best: { root: string; name: string } | null = null;
  let bestLen = -1;
  for (const r of roots) {
    const prefix = r.root.endsWith("/") ? r.root : `${r.root}/`;
    if (absPath === r.root || absPath.startsWith(prefix)) {
      if (prefix.length > bestLen) {
        best = r;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

export interface ProjectGroup<T> {
  name: string;
  root: string;
  items: T[];
}

/**
 * Bucket ranked results by owning project, preserving rank order: groups appear
 * in order of their best-ranked member, items keep their original order.
 */
export function groupResultsByProject<T>(
  results: T[],
  roots: { root: string; name: string }[],
  getPath: (r: T) => string,
): ProjectGroup<T>[] {
  const order: string[] = [];
  const buckets = new Map<string, ProjectGroup<T>>();
  for (const r of results) {
    const owner = projectForPath(getPath(r), roots);
    const key = owner?.root ?? "(unknown)";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        name: owner?.name ?? "(unknown)",
        root: owner?.root ?? "",
        items: [],
      };
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.items.push(r);
  }
  return order.map((k) => buckets.get(k) as ProjectGroup<T>);
}
