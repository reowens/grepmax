import * as path from "node:path";
import type { AsyncSubscription } from "@parcel/watcher";
import * as watcher from "@parcel/watcher";
import { ProjectBatchProcessor } from "../index/batch-processor";
import { ProjectFilePolicy } from "../index/file-policy";
import {
  createWalkState,
  isPathProtectedByWalkState,
  walk,
} from "../index/walker";
import { WATCHER_IGNORE_GLOBS } from "../index/watcher";
import type { MetaCache } from "../store/meta-cache";
import type { VectorDB } from "../store/vector-db";
import { computeContentHash, readFileSnapshot } from "../utils/file-utils";
import { debug as dbg } from "../utils/logger";
import { getProject, registerProject } from "../utils/project-registry";
import {
  registerWatcher,
  unregisterWatcherByRoot,
} from "../utils/watcher-store";
import type { WorkerPool } from "../workers/pool";

// Watcher health windows used for FSEvents auto-recovery.
const FSEVENTS_RECOVERY_INTERVAL_MS = 60 * 60 * 1000; // try recovery hourly
const FSEVENTS_HEALTH_WINDOW_MS = 5 * 60 * 1000; // 5 min of quiet = "healthy"

interface ActiveCatchup {
  controller: AbortController;
  dirty: boolean;
  promise: Promise<void>;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export interface WatcherManagerDeps {
  /** Shared with the daemon (read by search/indexState/shutdown). */
  processors: Map<string, ProjectBatchProcessor>;
  /** Shared with the daemon (touched by indexProject/shutdown). */
  subscriptions: Map<string, AsyncSubscription>;
  getVectorDb: () => VectorDB | null;
  getMetaCache: () => MetaCache | null;
  getWorkerPool?: () => WorkerPool | null;
  getShuttingDown: () => boolean;
  /** Reset the daemon's idle timer. */
  touchActivity: () => void;
  /** Drop a project's cached Searcher (daemon owns the searchers map). */
  evictSearcher: (root: string) => void;
  runProjectOperation?: <T>(
    root: string,
    name: string,
    signal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Owns per-project file watching: @parcel/watcher subscriptions, FSEvents
 * overflow recovery, poll-mode fallback, and the offline catchup scan. Holds the
 * watcher health/state maps; shares the `processors` and `subscriptions` maps
 * with the daemon by reference so the streaming index ops and shutdown can still
 * detach a project directly.
 *
 * Extracted from daemon.ts (Phase 2). Behavior-preserving — the daemon keeps
 * thin watchProject/unwatchProject delegators over this manager.
 */
export class WatcherManager {
  private readonly pendingOps = new Set<string>();
  private readonly watcherFailCount = new Map<string, number>();
  private readonly pollIntervals = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  private readonly pollRecoveryTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  private readonly recoveryTimeouts = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly lastOverflowMs = new Map<string, number>();
  private readonly lastCatchupEndMs = new Map<string, number>();
  private readonly catchups = new Map<string, ActiveCatchup>();
  private readonly degradedRoots = new Set<string>();
  private readonly terminalFailures = new Map<string, Set<string>>();
  private readonly watchLifecycles = new Map<string, AbortController>();

  constructor(private readonly deps: WatcherManagerDeps) {}

  async watchProject(
    root: string,
    options: { catchup?: boolean } = {},
  ): Promise<void> {
    if (this.deps.processors.has(root) || this.pendingOps.has(root)) return;
    const vectorDb = this.deps.getVectorDb();
    const metaCache = this.deps.getMetaCache();
    const workerPool = this.deps.getWorkerPool?.();
    if (!vectorDb || !metaCache || (this.deps.getWorkerPool && !workerPool))
      return;
    this.pendingOps.add(root);
    const lifecycle = new AbortController();
    this.watchLifecycles.set(root, lifecycle);
    const ownsLifecycle = () =>
      this.watchLifecycles.get(root) === lifecycle &&
      !lifecycle.signal.aborted &&
      !this.deps.getShuttingDown();

    try {
      const filePolicy = new ProjectFilePolicy(root);
      let processor!: ProjectBatchProcessor;
      processor = new ProjectBatchProcessor({
        projectRoot: root,
        vectorDb,
        metaCache,
        ...(workerPool ? { workerPool } : {}),
        filePolicy,
        onPolicyChange: () => {
          void this.runCatchup(root, processor).catch((err) => {
            console.error(
              `[daemon:${path.basename(root)}] Policy reconciliation failed:`,
              err,
            );
          });
        },
        onReindex: async (files, ms) => {
          console.log(
            `[daemon:${path.basename(root)}] Reindexed ${files} file${files !== 1 ? "s" : ""} (${(ms / 1000).toFixed(1)}s)`,
          );
          // Update project registry so gmax status shows fresh data
          const proj = getProject(root);
          if (proj) {
            let chunkCount = proj.chunkCount;
            try {
              chunkCount = await vectorDb.countRowsForPath(root);
            } catch (err) {
              console.warn(
                `[daemon:${path.basename(root)}] Failed to query chunk count: ${err}`,
              );
            }
            registerProject({
              ...proj,
              lastIndexed: new Date().toISOString(),
              chunkCount,
            });
          }
          // Back to watching after batch completes
          registerWatcher({
            pid: process.pid,
            projectRoot: root,
            startTime: Date.now(),
            status: this.isRootDegraded(root) ? "degraded" : "watching",
            lastHeartbeat: Date.now(),
            lastReindex: Date.now(),
          });
        },
        onActivity: () => {
          this.deps.touchActivity();
          // Mark as syncing while processing
          registerWatcher({
            pid: process.pid,
            projectRoot: root,
            startTime: Date.now(),
            status: this.isRootDegraded(root) ? "degraded" : "syncing",
            lastHeartbeat: Date.now(),
          });
        },
        onTerminalFailure: (absPath) => {
          const failed = this.terminalFailures.get(root) ?? new Set<string>();
          failed.add(absPath);
          this.terminalFailures.set(root, failed);
          registerWatcher({
            pid: process.pid,
            projectRoot: root,
            startTime: Date.now(),
            status: "degraded",
            lastError: `${failed.size} file(s) exhausted automatic retries`,
            lastHeartbeat: Date.now(),
          });
        },
        onPathSuccess: (absPath) => {
          const failed = this.terminalFailures.get(root);
          if (!failed?.delete(absPath)) return;
          if (failed.size === 0) this.terminalFailures.delete(root);
          registerWatcher({
            pid: process.pid,
            projectRoot: root,
            startTime: Date.now(),
            status: this.isRootDegraded(root) ? "degraded" : "watching",
            lastHeartbeat: Date.now(),
          });
        },
        runOperation: (fn) =>
          this.deps.runProjectOperation
            ? this.deps.runProjectOperation(root, "watch-batch", undefined, fn)
            : fn(new AbortController().signal),
      });

      if (!ownsLifecycle()) {
        await processor.close();
        return;
      }
      this.deps.processors.set(root, processor);

      // Subscribe with @parcel/watcher — native backend, no polling.
      // If the kernel refuses (e.g. FSEvents slots stuck after a prior kill -9),
      // fall straight through to poll mode. The retry/backoff path inside
      // recoverWatcher is for transient overflows, not hard kernel-level
      // subscribe failures, so we skip it on startup by priming failCount past
      // MAX before invoking it.
      try {
        await this.subscribeWatcher(root, processor);
      } catch (err) {
        if (!ownsLifecycle()) return;
        const name = path.basename(root);
        console.error(
          `[daemon:${name}] Subscribe failed at startup (${err instanceof Error ? err.message : err}) — switching to poll mode`,
        );
        this.watcherFailCount.set(root, 1_000); // > MAX_WATCHER_RETRIES
        this.lastOverflowMs.set(root, Date.now());
        this.recoverWatcher(root, processor);
      }

      if (!ownsLifecycle()) return;

      registerWatcher({
        pid: process.pid,
        projectRoot: root,
        startTime: Date.now(),
        status:
          processor.progress.processing || processor.progress.pendingFiles > 0
            ? "syncing"
            : "watching",
        lastHeartbeat: Date.now(),
      });

      // Catchup scan — find files changed while daemon was offline
      if (options.catchup !== false) {
        this.runCatchup(root, processor).catch((err) => {
          console.error(
            `[daemon:${path.basename(root)}] Catchup scan failed:`,
            err,
          );
        });
      }

      console.log(`[daemon] Watching ${root}`);
    } catch (error) {
      await this.unwatchProject(root).catch(() => {});
      throw error;
    } finally {
      this.pendingOps.delete(root);
    }
  }

  private isRootDegraded(root: string): boolean {
    return (
      this.degradedRoots.has(root) ||
      (this.terminalFailures.get(root)?.size ?? 0) > 0
    );
  }

  private async subscribeWatcher(
    root: string,
    processor: ProjectBatchProcessor,
  ): Promise<void> {
    const name = path.basename(root);
    if (this.deps.processors.get(root) !== processor) return;

    // Unsubscribe existing watcher if any (e.g. during recovery)
    const existingSub = this.deps.subscriptions.get(root);
    if (existingSub) {
      try {
        await existingSub.unsubscribe();
      } catch {}
      this.deps.subscriptions.delete(root);
    }

    const sub = await watcher.subscribe(
      root,
      (err, events) => {
        if (err) {
          console.error(`[daemon:${name}] Watcher error:`, err);
          this.recoverWatcher(root, processor);
          return;
        }
        // Only reset fail counter after sustained health (5min since last overflow)
        const lastOverflow = this.lastOverflowMs.get(root) ?? 0;
        if (Date.now() - lastOverflow > 5 * 60 * 1000) {
          this.watcherFailCount.delete(root);
        }
        for (const event of events) {
          processor.handleFileEvent(
            event.type === "delete" ? "unlink" : "change",
            event.path,
          );
        }
        this.deps.touchActivity();
      },
      { ignore: WATCHER_IGNORE_GLOBS },
    );
    if (this.deps.processors.get(root) !== processor) {
      await sub.unsubscribe();
      return;
    }
    this.deps.subscriptions.set(root, sub);
  }

  private recoverWatcher(root: string, processor: ProjectBatchProcessor): void {
    const name = path.basename(root);
    if (
      this.deps.getShuttingDown() ||
      this.deps.processors.get(root) !== processor
    )
      return;

    // Debounce: avoid multiple overlapping recovery attempts
    const recoveryKey = `recover:${root}`;
    if (this.pendingOps.has(recoveryKey)) return;
    this.pendingOps.add(recoveryKey);

    const fails = (this.watcherFailCount.get(root) ?? 0) + 1;
    this.watcherFailCount.set(root, fails);
    this.lastOverflowMs.set(root, Date.now());

    const MAX_WATCHER_RETRIES = 3;
    const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    if (fails > MAX_WATCHER_RETRIES) {
      // FSEvents can't handle this project — degrade to periodic catchup scans
      // Always tear down the broken sub, even if poll mode is already active —
      // this can happen if a recovery attempt resubscribed successfully then
      // re-overflowed during the 5-min health window.
      const sub = this.deps.subscriptions.get(root);
      if (sub) {
        sub.unsubscribe().catch(() => {});
        this.deps.subscriptions.delete(root);
      }
      if (!this.pollIntervals.has(root)) {
        console.error(
          `[daemon:${name}] FSEvents unreliable after ${fails} failures — switching to poll mode (${POLL_INTERVAL_MS / 60000}min interval)`,
        );
        // Run an immediate catchup, then schedule periodic ones
        this.runCatchup(root, processor).catch((err) => {
          console.error(`[daemon:${name}] Poll catchup failed:`, err);
        });
        const interval = setInterval(() => {
          if (
            this.deps.getShuttingDown() ||
            this.deps.processors.get(root) !== processor
          )
            return;
          this.deps.touchActivity();
          this.runCatchup(root, processor).catch((err) => {
            console.error(`[daemon:${name}] Poll catchup failed:`, err);
          });
        }, POLL_INTERVAL_MS);
        this.pollIntervals.set(root, interval);
        // Schedule periodic attempts to climb back to native FSEvents — after
        // a transient burst (large git checkout, npm install) the kernel
        // buffer often calms down within an hour.
        this.schedulePollModeRecovery(root, processor);
        registerWatcher({
          pid: process.pid,
          projectRoot: root,
          startTime: Date.now(),
          status: "watching",
          lastHeartbeat: Date.now(),
        });
      }
      this.pendingOps.delete(recoveryKey);
      return;
    }

    // Backoff: wait before re-subscribing (3s, 6s, 12s)
    const delayMs = 3000 * 2 ** (fails - 1);
    console.error(
      `[daemon:${name}] Recovering watcher (attempt ${fails}/${MAX_WATCHER_RETRIES}, backoff ${delayMs}ms)...`,
    );

    const timeout = setTimeout(() => {
      this.recoveryTimeouts.delete(root);
      if (
        this.deps.getShuttingDown() ||
        this.deps.processors.get(root) !== processor
      ) {
        this.pendingOps.delete(recoveryKey);
        return;
      }
      (async () => {
        try {
          await this.subscribeWatcher(root, processor);
          if (this.deps.processors.get(root) !== processor) return;
          const lastCatchup = this.lastCatchupEndMs.get(root) ?? 0;
          const CATCHUP_COOLDOWN_MS = 60_000;
          if (Date.now() - lastCatchup < CATCHUP_COOLDOWN_MS) {
            console.log(
              `[daemon:${name}] Skipping catchup scan (last completed ${Math.round((Date.now() - lastCatchup) / 1000)}s ago)`,
            );
          } else {
            await this.runCatchup(root, processor);
          }
          console.log(`[daemon:${name}] Watcher recovered`);
        } catch (err) {
          console.error(`[daemon:${name}] Watcher recovery failed:`, err);
        } finally {
          this.pendingOps.delete(recoveryKey);
        }
      })();
    }, delayMs);
    this.recoveryTimeouts.set(root, timeout);
  }

  /**
   * Once a project has fallen back to poll mode, periodically try to upgrade
   * back to native FSEvents. The buffer overflows that triggered the fallback
   * are usually transient (big git checkout, npm install, build output) — no
   * point staying in 5-min poll mode forever.
   */
  private schedulePollModeRecovery(
    root: string,
    processor: ProjectBatchProcessor,
  ): void {
    if (this.pollRecoveryTimers.has(root)) return;
    const name = path.basename(root);
    const lifecycle = this.watchLifecycles.get(root);
    if (!lifecycle) return;
    const timer = setInterval(() => {
      if (this.deps.getShuttingDown()) return;
      // Skip if a watcher recovery is already in flight or we're not in poll mode anymore.
      if (!this.pollIntervals.has(root)) {
        const t = this.pollRecoveryTimers.get(root);
        if (t) clearInterval(t);
        this.pollRecoveryTimers.delete(root);
        return;
      }
      if (this.pendingOps.has(`recover:${root}`)) return;

      void (async () => {
        if (this.deps.processors.get(root) !== processor) return;
        console.log(
          `[daemon:${name}] Attempting to leave poll mode and reattach FSEvents...`,
        );
        try {
          // Reset failure counter so subscribeWatcher's error path treats this
          // as a fresh start. If it fails again, we'll fall right back into
          // poll mode via the same recoverWatcher path.
          this.watcherFailCount.delete(root);
          await this.subscribeWatcher(root, processor);
          if (this.deps.processors.get(root) !== processor) return;

          // Wait one health window — if the new subscription survives without
          // another overflow, we consider it recovered and tear down poll mode.
          await abortableDelay(FSEVENTS_HEALTH_WINDOW_MS, lifecycle.signal);
          if (
            this.deps.getShuttingDown() ||
            this.deps.processors.get(root) !== processor
          )
            return;

          const lastOverflow = this.lastOverflowMs.get(root) ?? 0;
          if (Date.now() - lastOverflow < FSEVENTS_HEALTH_WINDOW_MS) {
            console.log(
              `[daemon:${name}] FSEvents recovery aborted — fresh overflow within health window, staying in poll mode`,
            );
            return; // recoverWatcher will have re-armed poll mode if needed
          }

          // Healthy — drop poll mode.
          const pollInterval = this.pollIntervals.get(root);
          if (pollInterval) {
            clearInterval(pollInterval);
            this.pollIntervals.delete(root);
          }
          const recoveryTimer = this.pollRecoveryTimers.get(root);
          if (recoveryTimer) {
            clearInterval(recoveryTimer);
            this.pollRecoveryTimers.delete(root);
          }
          console.log(
            `[daemon:${name}] FSEvents recovered — poll mode disabled`,
          );
        } catch (err) {
          console.error(
            `[daemon:${name}] Poll-mode recovery attempt failed:`,
            err,
          );
        }
      })();
    }, FSEVENTS_RECOVERY_INTERVAL_MS);
    timer.unref();
    this.pollRecoveryTimers.set(root, timer);
  }

  private async catchupScan(
    root: string,
    processor: ProjectBatchProcessor,
    signal: AbortSignal,
  ): Promise<boolean> {
    const { isFileCached } = await import("../utils/cache-check");

    const metaCache = this.deps.getMetaCache()!;
    processor.filePolicy.invalidateIgnoreCache();
    const rootPrefix = root.endsWith("/") ? root : `${root}/`;
    const cachedPaths = await metaCache.getKeysWithPrefix(rootPrefix);
    if (signal.aborted) return false;
    const seenPaths = new Set<string>();
    const walkState = createWalkState();

    let queued = 0;
    let skipped = 0;
    let debugSamples = 0;
    for await (const relPath of walk(root, {
      policy: processor.filePolicy,
      state: walkState,
    })) {
      if (signal.aborted) return false;
      const absPath = path.join(root, relPath);

      try {
        const classification = await processor.filePolicy.classifyFile(absPath);
        if (classification.status === "error") {
          walkState.protectedPaths.add(classification.protectedPath);
          walkState.errors.push({
            path: classification.protectedPath,
            error: classification.error,
          });
          continue;
        }
        if (classification.status !== "indexable") continue;
        const stats = classification.stat;
        seenPaths.add(absPath);
        const cached = metaCache.get(absPath);
        if (!isFileCached(cached, stats)) {
          // Fast path: if only mtime changed but size is identical and we have a hash,
          // just verify the hash in-process instead of sending to a worker.
          if (cached?.hash && cached.size === stats.size) {
            const snapshot = await readFileSnapshot(absPath, {
              projectRoot: root,
            });
            if (
              snapshot.size !== stats.size ||
              snapshot.mtimeMs !== stats.mtimeMs
            ) {
              processor.handleFileEvent("change", absPath);
              continue;
            }
            const hash = computeContentHash(snapshot.buffer, absPath);
            if (hash === cached.hash) {
              // Content unchanged — update mtime in cache and skip worker
              if (signal.aborted) return false;
              metaCache.put(absPath, { ...cached, mtimeMs: stats.mtimeMs });
              skipped++;
              continue;
            }
          }
          // Debug: log first few misses to diagnose re-queue loops
          if (debugSamples < 5) {
            dbg(
              "catchup",
              `miss ${relPath}: cached=${cached ? `mtime=${Math.trunc(cached.mtimeMs)} size=${cached.size}` : "null"} stat=mtime=${Math.trunc(stats.mtimeMs)} size=${stats.size}`,
            );
            debugSamples++;
          }
          if (signal.aborted) return false;
          processor.handleFileEvent("change", absPath);
          queued++;

          // Throttle: pause periodically during large catchup scans to let the
          // batch processor drain and compaction run between bursts.
          if (queued % 500 === 0) {
            dbg(
              "catchup",
              `${path.basename(root)}: throttle pause at ${queued} queued`,
            );
            await abortableDelay(5_000, signal);
          }
        } else {
          skipped++;
        }
      } catch (error) {
        walkState.protectedPaths.add(absPath);
        walkState.errors.push({ path: absPath, error });
      }
    }
    dbg(
      "catchup",
      `${path.basename(root)}: ${queued} queued, ${skipped} skipped (cached ok), ${seenPaths.size} total`,
    );

    // Purge files deleted while daemon was offline
    let purged = 0;
    for (const cachedPath of cachedPaths) {
      if (signal.aborted) return false;
      if (
        !seenPaths.has(cachedPath) &&
        !isPathProtectedByWalkState(cachedPath, walkState)
      ) {
        processor.handleFileEvent("unlink", cachedPath);
        purged++;
      }
    }

    const complete = walkState.rootComplete && walkState.errors.length === 0;
    if (!complete) {
      this.degradedRoots.add(root);
      registerWatcher({
        pid: process.pid,
        projectRoot: root,
        startTime: Date.now(),
        status: "degraded",
        lastHeartbeat: Date.now(),
        lastError: `${walkState.errors.length} scan path(s) incomplete`,
      });
    } else {
      this.degradedRoots.delete(root);
      const failedFiles = this.terminalFailures.get(root)?.size ?? 0;
      registerWatcher({
        pid: process.pid,
        projectRoot: root,
        startTime: Date.now(),
        status: this.isRootDegraded(root) ? "degraded" : "watching",
        lastHeartbeat: Date.now(),
        ...(failedFiles > 0
          ? { lastError: `${failedFiles} file(s) exhausted automatic retries` }
          : {}),
      });
    }

    if (queued > 0 || purged > 0) {
      const parts: string[] = [];
      if (queued > 0) parts.push(`${queued} changed`);
      if (purged > 0) parts.push(`${purged} deleted`);
      console.log(
        `[daemon:${path.basename(root)}] Catchup: ${parts.join(", ")} file(s) while offline`,
      );
    }

    this.lastCatchupEndMs.set(root, Date.now());
    return complete;
  }

  private runCatchup(
    root: string,
    processor: ProjectBatchProcessor,
  ): Promise<void> {
    const existing = this.catchups.get(root);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }
    const active: ActiveCatchup = {
      controller: new AbortController(),
      dirty: false,
      promise: Promise.resolve(),
    };
    const execute = async (signal: AbortSignal) => {
      let incompleteRetries = 0;
      do {
        active.dirty = false;
        const complete = await this.catchupScan(root, processor, signal);
        if (!complete && !signal.aborted && incompleteRetries < 3) {
          incompleteRetries++;
          active.dirty = true;
          await abortableDelay(1000 * 2 ** (incompleteRetries - 1), signal);
        } else if (complete) {
          incompleteRetries = 0;
        }
      } while (active.dirty && !signal.aborted);
    };
    const run = (
      this.deps.runProjectOperation
        ? this.deps.runProjectOperation(
            root,
            "watch-catchup",
            active.controller.signal,
            execute,
          )
        : execute(active.controller.signal)
    ).finally(() => {
      if (this.catchups.get(root) === active) this.catchups.delete(root);
    });
    active.promise = run;
    this.catchups.set(root, active);
    return run;
  }

  private async stopCatchup(root: string): Promise<void> {
    const active = this.catchups.get(root);
    if (!active) return;
    active.controller.abort();
    await active.promise.catch(() => {});
  }

  async unwatchProject(root: string): Promise<void> {
    // Stop poll-mode timers + their FSEvents recovery probe first, so a removed
    // project can't keep scanning until full daemon shutdown. These live
    // independently of the processor, so clear them even on the early return.
    this.watchLifecycles.get(root)?.abort();
    this.watchLifecycles.delete(root);
    const pollInterval = this.pollIntervals.get(root);
    if (pollInterval) {
      clearInterval(pollInterval);
      this.pollIntervals.delete(root);
    }
    const recoveryTimer = this.pollRecoveryTimers.get(root);
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      this.pollRecoveryTimers.delete(root);
    }
    const recoveryTimeout = this.recoveryTimeouts.get(root);
    if (recoveryTimeout) {
      clearTimeout(recoveryTimeout);
      this.recoveryTimeouts.delete(root);
    }
    this.pendingOps.delete(`recover:${root}`);

    const processor = this.deps.processors.get(root);
    this.deps.processors.delete(root);

    await this.stopCatchup(root);

    if (processor) await processor.close();

    const sub = this.deps.subscriptions.get(root);
    if (sub) {
      await sub.unsubscribe();
      this.deps.subscriptions.delete(root);
    }

    this.deps.evictSearcher(root);
    this.lastOverflowMs.delete(root);
    this.lastCatchupEndMs.delete(root);
    this.degradedRoots.delete(root);
    this.terminalFailures.delete(root);
    unregisterWatcherByRoot(root);

    console.log(`[daemon] Unwatched ${root}`);
  }

  async quiesceAll(): Promise<string[]> {
    const roots = [
      ...new Set([
        ...this.deps.processors.keys(),
        ...this.deps.subscriptions.keys(),
        ...this.watchLifecycles.keys(),
      ]),
    ];
    await this.teardown();
    await Promise.all(roots.map((root) => this.unwatchProject(root)));
    return roots;
  }

  async resumeAll(
    roots: readonly string[],
    options: { catchup?: boolean } = {},
  ): Promise<void> {
    if (this.deps.getShuttingDown()) return;
    for (const root of roots) await this.watchProject(root, options);
  }

  async catchupAll(roots: readonly string[]): Promise<void> {
    for (const root of roots) {
      const processor = this.deps.processors.get(root);
      if (processor) await this.runCatchup(root, processor);
    }
  }

  /**
   * Stop all poll intervals + their FSEvents recovery probes and unsubscribe
   * every watcher. Processors are closed by quiesceAll/unwatchProject before
   * worker teardown.
   */
  async teardown(): Promise<void> {
    for (const lifecycle of this.watchLifecycles.values()) lifecycle.abort();
    this.watchLifecycles.clear();
    for (const interval of this.pollIntervals.values()) {
      clearInterval(interval);
    }
    this.pollIntervals.clear();
    for (const interval of this.pollRecoveryTimers.values()) {
      clearInterval(interval);
    }
    this.pollRecoveryTimers.clear();
    for (const timeout of this.recoveryTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.recoveryTimeouts.clear();

    const catchups = [...this.catchups.values()];
    for (const active of catchups) active.controller.abort();
    await Promise.allSettled(catchups.map((active) => active.promise));

    for (const sub of this.deps.subscriptions.values()) {
      try {
        await sub.unsubscribe();
      } catch {}
    }
    this.deps.subscriptions.clear();
  }
}
