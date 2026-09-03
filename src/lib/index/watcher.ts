import * as path from "node:path";
import * as watcher from "@parcel/watcher";
import type { MetaCache } from "../store/meta-cache";
import type { VectorDB } from "../store/vector-db";
import { ProjectBatchProcessor } from "./batch-processor";
import { reconcileMetaEntry } from "./cache-coherence";
import { ProjectFilePolicy } from "./file-policy";
import { GENERATED_SOURCE_PATTERNS } from "./ignore-patterns";
import { createWalkState, isPathProtectedByWalkState, walk } from "./walker";

export interface WatcherHandle {
  close: () => Promise<void>;
  readonly progress: {
    pendingFiles: number;
    processing: boolean;
    failedFiles: number;
  };
}

export interface WatcherOptions {
  projectRoot: string;
  vectorDb: VectorDB;
  metaCache: MetaCache;
  dataDir: string;
  onReindex?: (files: number, durationMs: number) => void;
  onHealthChange?: (complete: boolean, errors: number) => void;
  initialScanErrors?: number;
  initialFailedFiles?: number;
}

// Directory names ignored at ANY depth. @parcel/watcher treats a non-glob
// ignore entry as a literal path resolved against the watch root, so a bare
// "dist" only covered <root>/dist — nested build dirs (packages/*/dist,
// nested node_modules, .turbo) still flooded the daemon with events on every
// build. Glob entries are matched against the path relative to the watch
// root, and a leading "**/" matches zero or more segments, so the expansion
// below covers both the top-level and nested cases.
const IGNORED_DIR_NAMES = [
  "node_modules",
  ".git",
  ".gmax",
  "dist",
  "build",
  ".build", // SwiftPM
  "DerivedData", // Xcode
  "out",
  "target",
  "__pycache__",
  "coverage",
  "venv",
  ".venv",
  "site-packages",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".gradle",
  ".m2",
  "vendor",
  "lancedb",
];

// Ignore patterns for @parcel/watcher (picomatch globs).
export const WATCHER_IGNORE_GLOBS: string[] = [
  // "**/<name>" ignores the directory entry itself, "**/<name>/**" its contents.
  ...IGNORED_DIR_NAMES.flatMap((name) => [`**/${name}`, `**/${name}/**`]),
  "**/*.tmp.*", // editor atomic save artifacts
  "**/*.sb-*", // Xcode swap files
  // Codegen output never reaches the index (file policy drops it), so don't
  // let it reach the watcher either — it is the dominant source of FSEvents
  // buffer overflows on large projects. Bare "*.ext" patterns are anchored to
  // the root by picomatch, so prefix them to match at any depth.
  ...GENERATED_SOURCE_PATTERNS.map((p) =>
    p.startsWith("**/") ? p : `**/${p}`,
  ),
];

export async function startWatcher(
  opts: WatcherOptions,
): Promise<WatcherHandle> {
  const { projectRoot } = opts;
  const wtag = `watch:${projectRoot.split("/").pop()}`;

  const filePolicy = new ProjectFilePolicy(projectRoot);
  let reconciliation: Promise<void> | null = null;
  let reconcileRequested = false;
  let closing = false;
  let scanHealthy = (opts.initialScanErrors ?? 0) === 0;
  let ingestionDegraded = (opts.initialFailedFiles ?? 0) > 0;
  let degradedRepairQueued = false;
  const terminalFailures = new Set<string>();
  let processor!: ProjectBatchProcessor;
  const reportHealthyIfSettled = () => {
    if (
      scanHealthy &&
      !ingestionDegraded &&
      terminalFailures.size === 0 &&
      processor.progress.pendingFiles === 0
    ) {
      opts.onHealthChange?.(true, 0);
    }
  };
  const reconcile = () => {
    if (closing) return;
    if (reconciliation) {
      reconcileRequested = true;
      return;
    }
    reconciliation = (async () => {
      let incompleteRetries = 0;
      do {
        reconcileRequested = false;
        filePolicy.invalidateIgnoreCache();
        const rootPrefix = projectRoot.endsWith("/")
          ? projectRoot
          : `${projectRoot}/`;
        const cached = await opts.metaCache.getKeysWithPrefix(rootPrefix);
        const vectorPaths =
          await opts.vectorDb.getDistinctPathsForPrefix(rootPrefix);
        const knownPaths = new Set([...cached, ...vectorPaths]);
        const seen = new Set<string>();
        const state = createWalkState();
        for await (const relative of walk(projectRoot, {
          policy: filePolicy,
          state,
        })) {
          if (closing) return;
          const absolute = path.join(projectRoot, relative);
          seen.add(absolute);
          const reconciliation = reconcileMetaEntry(
            absolute,
            opts.metaCache.get(absolute),
            vectorPaths.has(absolute),
          );
          if (reconciliation.action === "stamp") {
            opts.metaCache.put(absolute, reconciliation.entry);
          }
          processor.handleFileEvent("change", absolute, {
            forceReprocess: reconciliation.action === "reprocess",
          });
        }
        for (const cachedPath of knownPaths) {
          if (closing) return;
          if (
            !seen.has(cachedPath) &&
            !isPathProtectedByWalkState(cachedPath, state)
          ) {
            processor.handleFileEvent("unlink", cachedPath, {
              forceDelete: true,
            });
          }
        }
        if (!state.rootComplete || state.errors.length > 0) {
          scanHealthy = false;
          opts.onHealthChange?.(false, state.errors.length);
          console.error(
            `[${wtag}] Reconciliation incomplete at ${state.errors.length} path(s)`,
          );
          if (incompleteRetries < 3) {
            incompleteRetries++;
            reconcileRequested = true;
            await new Promise((resolve) =>
              setTimeout(resolve, 1000 * 2 ** (incompleteRetries - 1)),
            );
          }
        } else {
          scanHealthy = true;
          if (ingestionDegraded && processor.progress.pendingFiles > 0) {
            degradedRepairQueued = true;
          }
          reportHealthyIfSettled();
          incompleteRetries = 0;
        }
      } while (reconcileRequested && !closing);
    })()
      .catch((err) => console.error(`[${wtag}] Reconciliation failed:`, err))
      .finally(() => {
        reconciliation = null;
      });
  };
  processor = new ProjectBatchProcessor({
    ...opts,
    filePolicy,
    onPolicyChange: reconcile,
    onReindex: (files, durationMs) => {
      opts.onReindex?.(files, durationMs);
    },
    onBatchSettled: () => {
      reportHealthyIfSettled();
    },
    onTerminalFailure: (absPath) => {
      terminalFailures.add(absPath);
      opts.onHealthChange?.(false, terminalFailures.size);
    },
    onPathSuccess: (absPath) => {
      terminalFailures.delete(absPath);
      if (
        degradedRepairQueued &&
        terminalFailures.size === 0 &&
        processor.progress.pendingFiles === 0
      ) {
        ingestionDegraded = false;
        degradedRepairQueued = false;
      }
      reportHealthyIfSettled();
    },
  });

  const subscription = await watcher.subscribe(
    projectRoot,
    (err, events) => {
      if (err) {
        console.error(`[${wtag}] Watcher error:`, err);
        return;
      }
      for (const event of events) {
        processor.handleFileEvent(
          event.type === "delete" ? "unlink" : "change",
          event.path,
        );
      }
    },
    { ignore: WATCHER_IGNORE_GLOBS },
  );
  reconcile();

  return {
    get progress() {
      return processor.progress;
    },
    close: async () => {
      closing = true;
      await subscription.unsubscribe();
      await reconciliation;
      await processor.close();
    },
  };
}
