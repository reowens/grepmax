import * as path from "node:path";
import type * as watcher from "@parcel/watcher";
import type { MetaCache } from "../store/meta-cache";
import type { VectorDB } from "../store/vector-db";
import type { ProjectBatchProcessor } from "./batch-processor";
import type { ProjectFilePolicy } from "./file-policy";
import { GENERATED_SOURCE_PATTERNS } from "./ignore-patterns";
import {
  createWalkState,
  isPathProtectedByWalkState,
  type WalkState,
  walk,
} from "./walker";
import { isFSEventsGap } from "./watcher-errors";
import {
  readNativeWatcherIgnores,
  subscribeWithNativeExclusions,
  watcherIgnoreIdentity,
} from "./watcher-ignore";
import type { WatcherRecoveryTracker } from "./watcher-recovery";

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
  // Atomic-save temp files named `.!<pid>!<name>` (e.g. `.!8903!dotmd.md`).
  // picomatch treats `!` as a literal unless it leads the pattern or opens
  // an `!(...)` extglob, so this matches only that shape, at any depth.
  "**/.!*!*",
  "**/*.sb-*", // Xcode swap files
  // Codegen output never reaches the index (file policy drops it), so don't
  // let it reach the watcher either — it is the dominant source of FSEvents
  // buffer overflows on large projects. Bare "*.ext" patterns are anchored to
  // the root by picomatch, so prefix them to match at any depth.
  ...GENERATED_SOURCE_PATTERNS.map((p) =>
    p.startsWith("**/") ? p : `**/${p}`,
  ),
];

export interface WatcherSubscriptionOptions {
  root: string;
  recovery: WatcherRecoveryTracker;
  /** False once the owner no longer wants events or new subscriptions. */
  isActive: () => boolean;
  /** Every backend error, before it is classified. */
  onError?: (err: Error) => void;
  /** Parcel dropped events but kept its stream: a rescan covers the gap. */
  onGap: (err: Error) => void;
  /** The stream may be dead; the next update() subscribes again. */
  onTerminal: (err: Error) => void;
  /** Called for every delivery, including an error delivery with no events. */
  onEvents: (events: watcher.Event[]) => void;
}

/** One project's native subscription. Updates are serialized, and an update
 * whose ignore identity matches a healthy attached subscription is skipped. */
export class WatcherSubscription {
  private subscription: watcher.AsyncSubscription | null = null;
  private policy = "";
  private generation = 0;
  private retired = false;
  private pendingUpdate: Promise<void> = Promise.resolve();
  private terminalFailure = false;

  constructor(private readonly options: WatcherSubscriptionOptions) {}

  get failed(): boolean {
    return this.terminalFailure;
  }

  update(): Promise<void> {
    const next = this.pendingUpdate
      .catch(() => {})
      .then(() => this.updateNow());
    this.pendingUpdate = next;
    return next;
  }

  /** Wait for the queued update, ignoring its outcome. */
  settled(): Promise<void> {
    return this.pendingUpdate.catch(() => {});
  }

  /** Stop delivering events; a subscribe still in flight disposes itself. */
  retire(): void {
    this.retired = true;
    this.generation++;
  }

  async detach(): Promise<void> {
    const current = this.subscription;
    this.subscription = null;
    this.options.recovery.detached();
    await current?.unsubscribe();
  }

  private live(): boolean {
    return !this.retired && this.options.isActive();
  }

  private async updateNow(): Promise<void> {
    const { root, recovery } = this.options;
    if (!this.live()) return;
    const ignores = await readNativeWatcherIgnores(root, WATCHER_IGNORE_GLOBS);
    if (
      !this.live() ||
      (this.subscription &&
        !this.terminalFailure &&
        this.policy === watcherIgnoreIdentity(ignores))
    )
      return;
    const generation = ++this.generation;
    this.terminalFailure = false;
    await this.detach().catch(() => {});
    if (!this.live()) return;
    const { subscription, policy } = await subscribeWithNativeExclusions(
      root,
      (err, events) => {
        if (generation !== this.generation || !this.live()) return;
        if (err) {
          recovery.error(err);
          this.options.onError?.(err);
          if (isFSEventsGap(err)) this.options.onGap(err);
          else {
            // Terminal backend errors can clear Parcel's callbacks.
            this.terminalFailure = true;
            this.options.onTerminal(err);
          }
        }
        this.options.onEvents(events);
      },
      WATCHER_IGNORE_GLOBS,
      ignores,
    );
    if (generation !== this.generation || !this.live()) {
      await subscription.unsubscribe();
      return;
    }
    this.subscription = subscription;
    this.policy = policy;
    recovery.attached(policy);
  }
}

export interface ReconcileOptions {
  root: string;
  policy: ProjectFilePolicy;
  processor: ProjectBatchProcessor;
  metaCache: MetaCache;
  vectorDb: VectorDB;
  aborted: () => boolean;
  /** Returns true when the file counts as present, so it is not purged. */
  visit: (file: {
    absolute: string;
    relative: string;
    vectorPaths: Set<string>;
    state: WalkState;
  }) => Promise<boolean>;
}

export interface ReconcileResult {
  complete: boolean;
  state: WalkState;
  seen: number;
  purged: number;
}

/** Walk the project through file policy, hand each file to `visit`, then
 * queue deletes for known paths the walk neither saw nor protected. Returns
 * null when aborted. */
export async function reconcileProject(
  options: ReconcileOptions,
): Promise<ReconcileResult | null> {
  const { root, metaCache, vectorDb, processor, aborted } = options;
  const rootPrefix = root.endsWith("/") ? root : `${root}/`;
  const cachedPaths = await metaCache.getKeysWithPrefix(rootPrefix);
  const vectorPaths = await vectorDb.getDistinctPathsForPrefix(rootPrefix);
  const knownPaths = new Set([...cachedPaths, ...vectorPaths]);
  if (aborted()) return null;
  const seen = new Set<string>();
  const state = createWalkState();
  for await (const relative of walk(root, {
    policy: options.policy,
    state,
  })) {
    if (aborted()) return null;
    const absolute = path.join(root, relative);
    if (await options.visit({ absolute, relative, vectorPaths, state }))
      seen.add(absolute);
  }
  let purged = 0;
  for (const knownPath of knownPaths) {
    if (aborted()) return null;
    if (!seen.has(knownPath) && !isPathProtectedByWalkState(knownPath, state)) {
      processor.handleFileEvent("unlink", knownPath, {
        forceDelete: true,
        workKind: "cleanup",
      });
      purged++;
    }
  }
  return {
    complete: state.rootComplete && state.errors.length === 0,
    state,
    seen: seen.size,
    purged,
  };
}
