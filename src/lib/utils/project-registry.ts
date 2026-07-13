/**
 * Global project registry — tracks all indexed projects for
 * cross-project search and dimension compatibility checking.
 *
 * Stored in ~/.gmax/projects.json
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { PATHS } from "../../config";
import {
  computeEmbeddingFingerprint,
  type EmbeddingGenerationConfig,
  resolveEmbeddingGeneration,
} from "../index/embedding-generation";

export interface ProjectEntry {
  root: string;
  name: string;
  vectorDim: number;
  modelTier: string;
  embedMode: string;
  lastIndexed: string;
  chunkCount?: number;
  status?: "pending" | "indexed" | "error";
  /** CONFIG.CHUNKER_VERSION at the time of the last full index. Stamped only
   * by full-sync completion paths (not incremental batches) — a mismatch with
   * the current constant means the index needs `gmax index` to pick up
   * chunk-metadata fixes. */
  chunkerVersion?: number;
  embedModel?: string;
  mlxModel?: string;
  colbertModel?: string;
  embeddingFingerprint?: string;
  rebuildId?: string;
}

const REGISTRY_PATH = path.join(PATHS.globalRoot, "projects.json");
const REBUILD_JOURNAL_PATH = path.join(
  PATHS.globalRoot,
  "rebuild-journal.json",
);

export class ProjectRegistryConflictError extends Error {
  readonly code = "PROJECT_REGISTRY_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "ProjectRegistryConflictError";
  }
}

function loadRegistry(): ProjectEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to read project registry ${REGISTRY_PATH}: ${message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid project registry JSON ${REGISTRY_PATH}: ${message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Invalid project registry ${REGISTRY_PATH}: expected an array`,
    );
  }

  for (const [index, entry] of parsed.entries()) {
    if (!isProjectEntry(entry)) {
      throw new Error(
        `Invalid project registry entry at index ${index} in ${REGISTRY_PATH}`,
      );
    }
  }
  return parsed;
}

function isProjectEntry(entry: unknown): entry is ProjectEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const value = entry as Record<string, unknown>;
  const valid =
    typeof value.root === "string" &&
    value.root.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.vectorDim === "number" &&
    Number.isFinite(value.vectorDim) &&
    value.vectorDim > 0 &&
    typeof value.modelTier === "string" &&
    typeof value.embedMode === "string" &&
    typeof value.lastIndexed === "string" &&
    (value.status === undefined ||
      value.status === "pending" ||
      value.status === "indexed" ||
      value.status === "error") &&
    (value.chunkCount === undefined ||
      (typeof value.chunkCount === "number" &&
        Number.isFinite(value.chunkCount) &&
        value.chunkCount >= 0)) &&
    (value.chunkerVersion === undefined ||
      (typeof value.chunkerVersion === "number" &&
        Number.isInteger(value.chunkerVersion) &&
        value.chunkerVersion >= 0)) &&
    optionalNonEmptyString(value.embedModel) &&
    optionalNonEmptyString(value.mlxModel) &&
    optionalNonEmptyString(value.colbertModel) &&
    (value.embeddingFingerprint === undefined ||
      (typeof value.embeddingFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(value.embeddingFingerprint))) &&
    optionalNonEmptyString(value.rebuildId);
  if (!valid) return false;
  try {
    if (value.embeddingFingerprint !== undefined) {
      if (
        value.embedModel === undefined ||
        value.mlxModel === undefined ||
        value.colbertModel === undefined
      ) {
        return false;
      }
      return (
        value.embeddingFingerprint ===
        computeEmbeddingFingerprint({
          tier: value.modelTier as string,
          vectorDim: value.vectorDim as number,
          onnxModel: value.embedModel as string,
          mlxModel: value.mlxModel as string,
          colbertModel: value.colbertModel as string,
        })
      );
    }

    // Unstamped records predate exact generation identities. Keep accepting
    // their historical shape while retaining the old tier sanity checks.
    const generation = resolveEmbeddingGeneration({
      modelTier: value.modelTier as string,
      vectorDim: value.vectorDim as number,
      ...(value.mlxModel === undefined
        ? {}
        : { mlxModel: value.mlxModel as string }),
    });
    if (
      (value.embedModel !== undefined &&
        value.embedModel !== generation.onnxModel) ||
      (value.mlxModel !== undefined &&
        value.mlxModel !== generation.mlxModel) ||
      (value.colbertModel !== undefined &&
        value.colbertModel !== generation.colbertModel)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function optionalNonEmptyString(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.length > 0 && value === value.trim())
  );
}

function saveRegistry(entries: ProjectEntry[]): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  const tmp = `${REGISTRY_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  fs.renameSync(tmp, REGISTRY_PATH);
}

function withRegistryLock<T>(fn: () => T): T {
  // Ensure the directory exists for the lock target
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  // Ensure the file exists (lockSync needs it)
  if (!fs.existsSync(REGISTRY_PATH)) {
    fs.writeFileSync(REGISTRY_PATH, "[]\n");
  }
  let release: (() => void) | undefined;
  try {
    release = lockfile.lockSync(REGISTRY_PATH, { stale: 10_000 });
    return fn();
  } finally {
    try {
      release?.();
    } catch {}
  }
}

export function registerProject(entry: ProjectEntry): void {
  if (!isProjectEntry(entry)) {
    throw new Error("Invalid project registry entry");
  }
  withRegistryLock(() => {
    const entries = loadRegistry();
    let canonicalRoot: string | undefined;
    try {
      canonicalRoot = fs.realpathSync(entry.root);
    } catch {}
    if (canonicalRoot) {
      const duplicate = entries.find((existing) => {
        if (existing.root === entry.root) return false;
        try {
          return fs.realpathSync(existing.root) === canonicalRoot;
        } catch {
          return false;
        }
      });
      if (duplicate) {
        throw new Error(
          `Project root resolves to already registered project ${duplicate.root}`,
        );
      }
    }
    const idx = entries.findIndex((e) => e.root === entry.root);
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }
    saveRegistry(entries);
  });
}

export interface FullSyncProjectStamp {
  root: string;
  name?: string;
  generation: Readonly<EmbeddingGenerationConfig>;
  embedMode: "cpu" | "gpu";
  chunkCount: number;
  chunkerVersion: number;
  indexedAt?: string;
  expectedFingerprint?: string | null;
  expectedRebuildId?: string | null;
}

export interface ProjectRebuildReservation {
  readonly rebuildId: string;
  readonly previous: readonly Readonly<ProjectEntry>[];
  readonly reserved: readonly Readonly<ProjectEntry>[];
}

interface ProjectRebuildJournal extends ProjectRebuildReservation {
  readonly phase: "reserved" | "dropping";
  readonly targetFingerprint: string;
}

function immutableEntries(
  entries: readonly ProjectEntry[],
): readonly Readonly<ProjectEntry>[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

function saveRebuildJournal(journal: ProjectRebuildJournal): void {
  fs.mkdirSync(path.dirname(REBUILD_JOURNAL_PATH), { recursive: true });
  const temp = `${REBUILD_JOURNAL_PATH}.${journal.rebuildId}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`, {
    flag: "wx",
  });
  fs.renameSync(temp, REBUILD_JOURNAL_PATH);
}

function parseRebuildJournal(filePath: string): ProjectRebuildJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error(
      `Invalid rebuild journal ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid rebuild journal ${filePath}`);
  }
  const journal = parsed as ProjectRebuildJournal;
  if (
    typeof journal.rebuildId !== "string" ||
    (journal.phase !== "reserved" && journal.phase !== "dropping") ||
    typeof journal.targetFingerprint !== "string" ||
    !Array.isArray(journal.previous) ||
    !Array.isArray(journal.reserved) ||
    !journal.previous.every(isProjectEntry) ||
    !journal.reserved.every(isProjectEntry)
  ) {
    throw new Error(`Invalid rebuild journal ${filePath}`);
  }
  return journal;
}

function loadRebuildJournal(): ProjectRebuildJournal | null {
  const dir = path.dirname(REBUILD_JOURNAL_PATH);
  const prefix = `${path.basename(REBUILD_JOURNAL_PATH)}.`;
  let temps: string[] = [];
  try {
    temps = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
      .map((name) => path.join(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const validTemps: Array<{ path: string; journal: ProjectRebuildJournal }> =
    [];
  for (const temp of temps) {
    try {
      validTemps.push({ path: temp, journal: parseRebuildJournal(temp) });
    } catch {
      fs.rmSync(temp, { force: true });
    }
  }
  if (validTemps.length > 1) {
    throw new Error(`Multiple rebuild journal temp files found in ${dir}`);
  }
  if (validTemps.length === 1) {
    const candidate = validTemps[0];
    try {
      const current = parseRebuildJournal(REBUILD_JOURNAL_PATH);
      if (current.rebuildId !== candidate.journal.rebuildId) {
        throw new Error("Rebuild journal temp identity changed");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fs.renameSync(candidate.path, REBUILD_JOURNAL_PATH);
  }

  try {
    return parseRebuildJournal(REBUILD_JOURNAL_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function removeRebuildJournal(rebuildId: string): void {
  const current = loadRebuildJournal();
  if (current?.rebuildId !== rebuildId) return;
  fs.rmSync(REBUILD_JOURNAL_PATH, { force: true });
}

export function reserveProjectsForRebuild(
  generation: Readonly<EmbeddingGenerationConfig>,
): Readonly<ProjectRebuildReservation> {
  return withRegistryLock(() => {
    const entries = loadRegistry();
    const existingJournal = loadRebuildJournal();
    if (existingJournal) {
      if (existingJournal.targetFingerprint !== generation.fingerprint) {
        throw new ProjectRegistryConflictError(
          "Configured embedding changed during an unfinished rebuild",
        );
      }
      const previousByRoot = new Map(
        existingJournal.previous.map((entry) => [entry.root, entry]),
      );
      const previous = immutableEntries(
        entries.map((entry) => previousByRoot.get(entry.root) ?? entry),
      );
      const roots = new Set(entries.map((entry) => entry.root));
      const resumed = entries.map(
        (entry): ProjectEntry =>
          roots.has(entry.root)
            ? {
                ...entry,
                vectorDim: generation.vectorDim,
                modelTier: generation.tier,
                embedModel: generation.onnxModel,
                mlxModel: generation.mlxModel,
                colbertModel: generation.colbertModel,
                embeddingFingerprint: generation.fingerprint,
                status: "pending",
                rebuildId: existingJournal.rebuildId,
              }
            : entry,
      );
      saveRebuildJournal({
        ...existingJournal,
        previous,
        reserved: immutableEntries(resumed),
      });
      saveRegistry(resumed);
      return Object.freeze({
        rebuildId: existingJournal.rebuildId,
        previous,
        reserved: immutableEntries(resumed),
      });
    }
    if (entries.some((entry) => entry.rebuildId)) {
      throw new ProjectRegistryConflictError(
        "A project is already reserved by an active rebuild",
      );
    }

    const rebuildId = randomUUID();
    const previous = immutableEntries(entries);
    const reservedEntries = entries.map(
      (entry): ProjectEntry => ({
        ...entry,
        vectorDim: generation.vectorDim,
        modelTier: generation.tier,
        embedModel: generation.onnxModel,
        mlxModel: generation.mlxModel,
        colbertModel: generation.colbertModel,
        embeddingFingerprint: generation.fingerprint,
        status: "pending",
        rebuildId,
      }),
    );
    if (!reservedEntries.every(isProjectEntry)) {
      throw new Error("Invalid rebuild generation reservation");
    }
    const journal: ProjectRebuildJournal = {
      rebuildId,
      phase: "reserved",
      targetFingerprint: generation.fingerprint,
      previous,
      reserved: immutableEntries(reservedEntries),
    };
    saveRebuildJournal(journal);
    try {
      saveRegistry(reservedEntries);
    } catch (error) {
      removeRebuildJournal(rebuildId);
      throw error;
    }
    return Object.freeze({
      rebuildId,
      previous,
      reserved: immutableEntries(reservedEntries),
    });
  });
}

export function restoreProjectsAfterRebuild(
  reservation: Readonly<ProjectRebuildReservation>,
): void {
  withRegistryLock(() => {
    const entries = loadRegistry();
    const previousByRoot = new Map(
      reservation.previous.map((entry) => [entry.root, entry]),
    );
    let changed = false;
    const restored = entries.map((entry): ProjectEntry => {
      if (entry.rebuildId !== reservation.rebuildId) return entry;
      const previous = previousByRoot.get(entry.root);
      if (!previous) return entry;
      changed = true;
      return { ...previous };
    });
    if (changed) saveRegistry(restored);
    removeRebuildJournal(reservation.rebuildId);
  });
}

export function markProjectRebuildDropping(
  reservation: Readonly<ProjectRebuildReservation>,
): void {
  withRegistryLock(() => {
    const journal = loadRebuildJournal();
    if (!journal || journal.rebuildId !== reservation.rebuildId) {
      throw new ProjectRegistryConflictError(
        "Project rebuild journal identity changed",
      );
    }
    saveRebuildJournal({ ...journal, phase: "dropping" });
  });
}

export function completeProjectRebuild(rebuildId: string): void {
  withRegistryLock(() => {
    const remaining = loadRegistry().some(
      (entry) => entry.rebuildId === rebuildId,
    );
    if (remaining) {
      throw new ProjectRegistryConflictError(
        "Cannot complete rebuild while projects remain pending",
      );
    }
    removeRebuildJournal(rebuildId);
  });
}

export function hasUnfinishedProjectRebuild(): boolean {
  return withRegistryLock(() => loadRebuildJournal() !== null);
}

export function stampProjectFullSync(
  stamp: FullSyncProjectStamp,
): ProjectEntry {
  return withRegistryLock(() => {
    const entries = loadRegistry();
    const idx = entries.findIndex((entry) => entry.root === stamp.root);
    const previous = idx >= 0 ? entries[idx] : undefined;
    if (previous?.rebuildId && stamp.expectedRebuildId === undefined) {
      throw new ProjectRegistryConflictError(
        "Project is reserved by an active rebuild",
      );
    }
    if (
      stamp.expectedFingerprint !== undefined &&
      (previous?.embeddingFingerprint ?? null) !== stamp.expectedFingerprint
    ) {
      throw new ProjectRegistryConflictError(
        "Project embedding fingerprint changed during indexing",
      );
    }
    if (
      stamp.expectedRebuildId !== undefined &&
      (previous?.rebuildId ?? null) !== stamp.expectedRebuildId
    ) {
      throw new ProjectRegistryConflictError(
        "Project rebuild identity changed during indexing",
      );
    }
    const entry: ProjectEntry = {
      ...previous,
      root: stamp.root,
      name: stamp.name ?? previous?.name ?? path.basename(stamp.root),
      vectorDim: stamp.generation.vectorDim,
      modelTier: stamp.generation.tier,
      embedMode: stamp.embedMode,
      embedModel: stamp.generation.onnxModel,
      mlxModel: stamp.generation.mlxModel,
      colbertModel: stamp.generation.colbertModel,
      embeddingFingerprint: stamp.generation.fingerprint,
      lastIndexed: stamp.indexedAt ?? new Date().toISOString(),
      chunkCount: stamp.chunkCount,
      status: "indexed",
      chunkerVersion: stamp.chunkerVersion,
    };
    delete entry.rebuildId;
    if (!isProjectEntry(entry)) {
      throw new Error("Invalid full-sync project stamp");
    }
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    saveRegistry(entries);
    return entry;
  });
}

export function listProjects(): ProjectEntry[] {
  return loadRegistry();
}

export function getProject(root: string): ProjectEntry | undefined {
  return loadRegistry().find((e) => e.root === root);
}

export function removeProject(root: string): void {
  withRegistryLock(() => {
    const entries = loadRegistry().filter((e) => e.root !== root);
    saveRegistry(entries);
  });
}

/**
 * Find a registered parent that covers this path, if any.
 */
export function getParentProject(root: string): ProjectEntry | undefined {
  const resolved = root.endsWith("/") ? root : `${root}/`;
  return loadRegistry().find(
    (e) =>
      e.root !== root &&
      resolved.startsWith(e.root.endsWith("/") ? e.root : `${e.root}/`),
  );
}

/**
 * Find registered projects that are children of this path.
 */
export function getChildProjects(root: string): ProjectEntry[] {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return loadRegistry().filter(
    (e) => e.root !== root && e.root.startsWith(prefix),
  );
}

/**
 * Resolve a `--root` argument with cwd fallback, printing the helper's
 * error message and setting process.exitCode = 1 on failure. Returns
 * null when the caller should bail out. Used at command entry points.
 */
export function resolveRootOrExit(arg: string | undefined): string | null {
  if (!arg) return process.cwd();
  try {
    return resolveProjectRoot(arg);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return null;
  }
}

/**
 * Resolve a `--root` argument that may be either a path or a registered
 * project name. Throws on no-match or duplicate-name so callers can
 * report a uniform error.
 */
export function resolveProjectRoot(arg: string): string {
  if (arg.includes("/") || arg.includes("\\")) return path.resolve(arg);
  const resolved = path.resolve(arg);
  if (fs.existsSync(resolved)) return resolved;

  const matches = loadRegistry().filter((p) => p.name === arg);
  if (matches.length === 1) return matches[0].root;
  if (matches.length === 0) {
    const all = loadRegistry();
    const list =
      all.length > 0
        ? all.map((p) => `  ${p.name.padEnd(24)} ${p.root}`).join("\n")
        : "  (none registered)";
    throw new Error(
      `No registered project named "${arg}".\nAvailable:\n${list}`,
    );
  }
  const paths = matches.map((p) => `  ${p.root}`).join("\n");
  throw new Error(
    `Multiple registered projects named "${arg}":\n${paths}\nPass an absolute path to disambiguate.`,
  );
}
