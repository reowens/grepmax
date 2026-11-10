import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as watcher from "@parcel/watcher";
import type { MetaCache } from "../store/meta-cache";
import type { VectorDB } from "../store/vector-db";
import { isPathWithin } from "../utils/path-containment";
import type { ProjectBatchProcessor } from "./batch-processor";
import type { ProjectFilePolicy } from "./file-policy";
import {
  createWalkState,
  isPathProtectedByWalkState,
  type WalkState,
  walk,
  walkDirectories,
} from "./walker";
import {
  CoverageGap,
  isEventGap,
  vanishedSubscribePath,
} from "./watcher-errors";
import {
  type NativeSubscription,
  readNativeWatcherIgnores,
  subscribeWithNativeExclusions,
  watcherIgnoreIdentity,
} from "./watcher-ignore";
import type { WatcherRecoveryTracker } from "./watcher-recovery";

// A folder removed during the crawl fails the whole subscribe with ENOENT.
// The next crawl usually passes, so retry before calling the watcher failed.
export const VANISHED_PATH_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

// Inotify watches a new folder, but not the subfolders already inside it when
// its watch lands. A subscribe crawls the whole tree, so new folders share 1
// re-subscribe, and their walk covers the files written before it.
export const NEW_FOLDER_RESUBSCRIBE_DELAY_MS = 5 * 60_000;
export const NEW_FOLDERS_UNWATCHED = "new folders wait for a re-subscribe";

// Parcel drops IN_Q_OVERFLOW without an error. A delivery this large is the
// nearest signal that the kernel queue (16,384 events by default) overflowed.
export const POSSIBLE_OVERFLOW_EVENT_COUNT = 4_096;

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
  /** A subscribe failed on a folder that vanished; it runs again after the delay. */
  onRetry?: (err: Error, vanished: string, delayMs: number) => void;
  /** Linux only: each new folder is walked through policy, and one holding a
   * subfolder asks the owner for a re-subscribe and a catch-up. */
  newFolders?: {
    policy: ProjectFilePolicy;
    onResubscribeDue: () => void;
  };
  platform?: NodeJS.Platform;
}

/** One project's native subscription. Updates are serialized, and an update
 * whose ignore identity matches a healthy attached subscription is skipped. */
export class WatcherSubscription {
  private subscription: watcher.AsyncSubscription | null = null;
  // The ignore set policy asked for when this subscription attached.
  private wanted = "";
  private generation = 0;
  private retired = false;
  private pendingUpdate: Promise<void> = Promise.resolve();
  private terminalFailure = false;
  private wake: (() => void) | null = null;
  private resubscribeTimer: ReturnType<typeof setTimeout> | undefined;
  private resubscribeWanted = false;
  private forceNext = false;

  constructor(private readonly options: WatcherSubscriptionOptions) {}

  get failed(): boolean {
    return this.terminalFailure;
  }

  /** Why the attached subscription misses part of the tree, if it does. */
  get coverageGap(): string | undefined {
    return this.resubscribeWanted ? NEW_FOLDERS_UNWATCHED : undefined;
  }

  private get linux(): boolean {
    return (this.options.platform ?? process.platform) === "linux";
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
    this.wake?.();
    clearTimeout(this.resubscribeTimer);
    this.resubscribeTimer = undefined;
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private async vanishedPath(err: unknown): Promise<string | null> {
    const { root } = this.options;
    const vanished = vanishedSubscribePath(err, root);
    if (vanished !== "") return vanished;
    // Parcel's crawl names no path; a missing root is not a transient race.
    const stat = await fs.stat(root).catch(() => null);
    return stat?.isDirectory() ? "" : null;
  }

  private async subscribe(
    callback: watcher.SubscribeCallback,
    ignores: Array<string | RegExp>,
    current: () => boolean,
  ): Promise<NativeSubscription | null> {
    for (const delayMs of [...VANISHED_PATH_RETRY_DELAYS_MS, undefined]) {
      try {
        return await subscribeWithNativeExclusions(
          this.options.root,
          callback,
          ignores,
        );
      } catch (err) {
        if (delayMs === undefined || !current()) throw err;
        const vanished = await this.vanishedPath(err);
        if (vanished === null) throw err;
        this.options.onRetry?.(err as Error, vanished, delayMs);
        await this.sleep(delayMs);
        if (!current()) return null;
      }
    }
    return null;
  }

  private deliverError(err: Error): void {
    this.options.recovery.error(err);
    this.options.onError?.(err);
    if (isEventGap(err)) this.options.onGap(err);
    else {
      // Terminal backend errors can clear Parcel's callbacks.
      this.terminalFailure = true;
      this.options.onTerminal(err);
    }
  }

  private requestResubscribe(): void {
    if (!this.subscription || this.terminalFailure) return;
    this.resubscribeWanted = true;
    if (this.resubscribeTimer || this.forceNext) return;
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = undefined;
      if (!this.subscription || this.terminalFailure)
        this.resubscribeWanted = false;
      if (!this.live() || !this.resubscribeWanted) return;
      this.forceNext = true;
      this.options.newFolders?.onResubscribeDue();
    }, NEW_FOLDER_RESUBSCRIBE_DELAY_MS);
    this.resubscribeTimer.unref?.();
  }

  /** Walk each created folder so files written before its watch are indexed,
   * and ask for a re-subscribe when it already holds a subfolder. Parcel
   * reports a folder removed and created in one delivery as an update. */
  private async coverNewFolders(
    events: watcher.Event[],
    current: () => boolean,
  ): Promise<void> {
    const policy = this.options.newFolders?.policy;
    if (!policy) return;
    const created = events
      .filter((event) => event.type !== "delete")
      .map((event) => event.path)
      .sort((a, b) => a.length - b.length);
    const walked: string[] = [];
    for (const folder of created) {
      if (walked.some((done) => isPathWithin(done, folder))) continue;
      const stat = await fs.lstat(folder).catch(() => null);
      if (!current()) return;
      if (!stat?.isDirectory()) continue;
      walked.push(folder);
      const files: watcher.Event[] = [];
      for await (const relative of walk(folder, { policy }))
        files.push({ type: "create", path: path.join(folder, relative) });
      if (!current()) return;
      if (files.length > 0) this.options.onEvents(files);
      for await (const directory of walkDirectories(folder, policy)) {
        if (directory.depth > 0 && directory.result.status === "traverse") {
          this.requestResubscribe();
          break;
        }
      }
    }
  }

  private async updateNow(): Promise<void> {
    const { root, recovery } = this.options;
    const force = this.forceNext;
    this.forceNext = false;
    if (!this.live()) return;
    const ignores = await readNativeWatcherIgnores(root);
    if (
      !this.live() ||
      (!force &&
        this.subscription &&
        !this.terminalFailure &&
        this.wanted === watcherIgnoreIdentity(ignores))
    )
      return;
    const generation = ++this.generation;
    this.terminalFailure = false;
    await this.detach().catch(() => {});
    if (!this.live()) return;
    const current = () => generation === this.generation && this.live();
    const callback: watcher.SubscribeCallback = (err, events) => {
      if (!current()) return;
      if (err) this.deliverError(err);
      else if (this.linux && events.length >= POSSIBLE_OVERFLOW_EVENT_COUNT)
        this.deliverError(
          new CoverageGap(
            `possible inotify overflow (${events.length} events in one delivery), catch-up pending`,
          ),
        );
      this.options.onEvents(events);
      if (this.linux && this.options.newFolders)
        this.coverNewFolders(events, current).catch(() => {});
    };
    const attached = await this.subscribe(callback, ignores, current);
    if (!attached) return;
    const { subscription, policy, wanted } = attached;
    if (generation !== this.generation || !this.live()) {
      await subscription.unsubscribe();
      return;
    }
    this.subscription = subscription;
    this.wanted = wanted;
    this.resubscribeWanted = false;
    clearTimeout(this.resubscribeTimer);
    this.resubscribeTimer = undefined;
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
