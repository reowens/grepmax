// This module is shared by the bridge and daemon. Node built-ins only.
import * as fs from "node:fs";
import * as path from "node:path";
import { matchStore, storesFilePath } from "../utils/stores";

export const DOCUMENT_CONTRACT_VERSION = 1;
export const DOCUMENT_CAPABILITIES = Object.freeze({
  existingIndexOnly: 1,
  queryLogging: false,
  watch: false,
  runtimeStartup: false,
});
export const DOCUMENT_LIMITS = Object.freeze({
  query: 500,
  prefixes: 32,
  paths: 2000,
  pathBytes: 512 * 1024,
  frameBytes: 1024 * 1024,
  candidates: 50,
  deadlineMs: 10000,
});
export const DOCUMENT_STATES = new Set([
  "unsupported_tool",
  "unsupported_daemon",
  "no_index",
  "index_unavailable",
  "daemon_unavailable",
  "store_unavailable",
  "embedding_unavailable",
  "embedding_mismatch",
  "host_pressure",
  "busy",
  "cancelled",
  "timeout",
  "no_coverage",
  "search_unavailable",
]);
export function documentFailure(state: string): { ok: false; state: string } {
  return {
    ok: false,
    state: DOCUMENT_STATES.has(state) ? state : "search_unavailable",
  };
}
export function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export interface DocumentContext {
  root: string;
  wireRoot: string;
  checkout: string;
  store: string;
  lastIndexed: string | null;
}
export function selectDocumentContext(
  home: string,
  cwd: string,
): DocumentContext {
  const checkout = fs.realpathSync(cwd);
  try {
    if (fs.statSync(storesFilePath()).size > DOCUMENT_LIMITS.frameBytes)
      throw new Error("store_unavailable");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    matchStore(checkout).kind !== "primary" ||
    process.env.GMAX_SECONDARY_STORE === "1"
  )
    throw new Error("store_unavailable");
  const registry = path.join(home, "projects.json");
  let projects: unknown;
  try {
    if (fs.statSync(registry).size > DOCUMENT_LIMITS.frameBytes)
      throw new Error();
    projects = JSON.parse(fs.readFileSync(registry, "utf8"));
  } catch {
    throw new Error("no_index");
  }
  if (!Array.isArray(projects)) throw new Error("no_index");
  const roots: Array<{
    root: string;
    wireRoot: string;
    lastIndexed: string | null;
  }> = [];
  for (const project of projects) {
    if (
      !project ||
      typeof project.root !== "string" ||
      !path.isAbsolute(project.root) ||
      project.status === "error"
    )
      continue;
    try {
      const root = fs.realpathSync(project.root);
      if (inside(root, checkout))
        roots.push({
          root,
          wireRoot: project.root,
          lastIndexed: documentIndexedAt(project.lastIndexed),
        });
    } catch {
      /* deleted registry root */
    }
  }
  roots.sort((a, b) => b.root.length - a.root.length);
  if (!roots[0]) throw new Error("no_index");
  return { ...roots[0], checkout, store: path.join(home, "lancedb") };
}
export function documentPaths(
  value: unknown,
  context: DocumentContext,
  mode: "paths" | "prefixes",
): string[] {
  return resolveDocumentPaths(value, context, mode, false).paths;
}

/** A disappearing sampled file reduces coverage; it cannot broaden retrieval. */
export function documentCoveragePaths(
  value: unknown,
  context: DocumentContext,
): { paths: string[]; requested: number } {
  return resolveDocumentPaths(value, context, "paths", true);
}

function resolveDocumentPaths(
  value: unknown,
  context: DocumentContext,
  mode: "paths" | "prefixes",
  allowMissing: boolean,
): { paths: string[]; requested: number } {
  if (
    !Array.isArray(value) ||
    value.length > DOCUMENT_LIMITS[mode] ||
    (mode === "prefixes" && !value.length) ||
    Buffer.byteLength(JSON.stringify(value)) > DOCUMENT_LIMITS.pathBytes
  )
    throw new Error("no_coverage");
  const paths = [
    ...new Set(
      value.flatMap((input: unknown) => {
        if (
          typeof input !== "string" ||
          !input ||
          input.includes("\0") ||
          !path.isAbsolute(input)
        )
          throw new Error("no_coverage");
        let real: string;
        try {
          real = fs.realpathSync(input);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            allowMissing &&
            (code === "ENOENT" || code === "ENOTDIR") &&
            path.extname(input).toLowerCase() === ".md"
          ) {
            // Validate the nearest surviving parent too: missing paths outside
            // the selected scope are invalid, not silently accepted coverage.
            let parent = path.dirname(path.resolve(input));
            for (;;) {
              try {
                const realParent = fs.realpathSync(parent);
                if (
                  !inside(context.checkout, realParent) ||
                  !inside(context.root, realParent)
                )
                  throw new Error("no_coverage");
                return [];
              } catch (parentError) {
                if (
                  !["ENOENT", "ENOTDIR"].includes(
                    (parentError as NodeJS.ErrnoException).code ?? "",
                  ) ||
                  parent === path.dirname(parent)
                )
                  throw new Error("no_coverage");
                parent = path.dirname(parent);
              }
            }
          }
          throw new Error("no_coverage");
        }
        if (
          !inside(context.checkout, real) ||
          !inside(context.root, real) ||
          (mode === "paths" &&
            (path.extname(real).toLowerCase() !== ".md" ||
              !fs.statSync(real).isFile()))
        )
          throw new Error("no_coverage");
        return [path.join(context.wireRoot, path.relative(context.root, real))];
      }),
    ),
  ];
  if (Buffer.byteLength(JSON.stringify(paths)) > DOCUMENT_LIMITS.pathBytes)
    throw new Error("no_coverage");
  return { paths, requested: new Set(value).size };
}

export function documentGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function documentIndexedAt(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}
export function documentMtime(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
    ? value
    : null;
}
/** Deliberate metadata allowlist; no free-form diagnostics or cached content. */
export function documentIndexState(value: unknown): Record<string, unknown> {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  const has = (key: string) =>
    Object.getOwnPropertyDescriptor(source, key) !== undefined;
  let invalid = typeof source.indexing !== "boolean";
  for (const key of ["indexing", "verifying", "degraded", "catchupRunning"])
    if (typeof source[key] === "boolean") out[key] = source[key];
    else if (has(key)) invalid = true;
  for (const key of ["pendingFiles", "failedFiles", "overflowCount"])
    if (
      typeof source[key] === "number" &&
      Number.isSafeInteger(source[key]) &&
      (source[key] as number) >= 0
    )
      out[key] = source[key];
    else if (has(key)) invalid = true;
  for (const key of ["lastReconciledAt", "catchupMs"])
    if (documentMtime(source[key]) !== null) out[key] = source[key];
    else if (has(key)) invalid = true;
  if (
    typeof source.watcherMode === "string" &&
    ["native", "polling", "recovering"].includes(source.watcherMode)
  )
    out.watcherMode = source.watcherMode;
  else if (has("watcherMode")) invalid = true;
  if (invalid) out.degraded = true;
  return out;
}
export function documentQueryState(value: unknown): string {
  return typeof value === "string" &&
    ["ready", "busy", "embedding_unavailable", "host_pressure"].includes(value)
    ? value
    : "embedding_unavailable";
}
export function canonicalPointer(
  input: string,
  context: DocumentContext,
): string | null {
  try {
    const real = fs.realpathSync(input);
    return inside(context.checkout, real) &&
      inside(context.root, real) &&
      path.extname(real).toLowerCase() === ".md" &&
      fs.statSync(real).isFile()
      ? real
      : null;
  } catch {
    return null;
  }
}
