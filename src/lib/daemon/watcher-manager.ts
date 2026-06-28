import type { AsyncSubscription } from "@parcel/watcher";
import * as watcher from "@parcel/watcher";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProjectBatchProcessor } from "../index/batch-processor";
import { WATCHER_IGNORE_GLOBS } from "../index/watcher";
import type { MetaCache } from "../store/meta-cache";
import type { VectorDB } from "../store/vector-db";
import { debug as dbg } from "../utils/logger";
import { getProject, registerProject } from "../utils/project-registry";
import {
  registerWatcher,
  unregisterWatcherByRoot,
} from "../utils/watcher-store";

// Watcher health windows used for FSEvents auto-recovery.
const FSEVENTS_RECOVERY_INTERVAL_MS = 60 * 60 * 1000; // try recovery hourly
const FSEVENTS_HEALTH_WINDOW_MS = 5 * 60 * 1000; // 5 min of quiet = "healthy"

export interface WatcherManagerDeps {
  /** Shared with the daemon (read by search/indexState/shutdown). */
  processors: Map<string, ProjectBatchProcessor>;
  /** Shared with the daemon (touched by indexProject/shutdown). */
  subscriptions: Map<string, AsyncSubscription>;
  getVectorDb: () => VectorDB | null;
  getMetaCache: () => MetaCache | null;
  getShuttingDown: () => boolean;
  /** Reset the daemon's idle timer. */
  touchActivity: () => void;
  /** Drop a project's cached Searcher (daemon owns the searchers map). */
  evictSearcher: (root: string) => void;
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
  private readonly lastOverflowMs = new Map<string, number>();
  private readonly lastCatchupEndMs = new Map<string, number>();

  constructor(private readonly deps: WatcherManagerDeps) {}

  async watchProject(root: string): Promise<void> {
    if (this.deps.processors.has(root) || this.pendingOps.has(root)) return;
    const vectorDb = this.deps.getVectorDb();
    const metaCache = this.deps.getMetaCache();
    if (!vectorDb || !metaCache) return;
    this.pendingOps.add(root);

    const processor = new ProjectBatchProcessor({
      projectRoot: root,
      vectorDb,
      metaCache,
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
          status: "watching",
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
          status: "syncing",
          lastHeartbeat: Date.now(),
        });
      },
    });

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
      const name = path.basename(root);
      console.error(
        `[daemon:${name}] Subscribe failed at startup (${err instanceof Error ? err.message : err}) — switching to poll mode`,
      );
      this.watcherFailCount.set(root, 1_000); // > MAX_WATCHER_RETRIES
      this.lastOverflowMs.set(root, Date.now());
      this.recoverWatcher(root, processor);
    }

    registerWatcher({
      pid: process.pid,
      projectRoot: root,
      startTime: Date.now(),
      status: "watching",
      lastHeartbeat: Date.now(),
    });

    // Catchup scan — find files changed while daemon was offline
    this.catchupScan(root, processor).catch((err) => {
      console.error(
        `[daemon:${path.basename(root)}] Catchup scan failed:`,
        err,
      );
    });

    this.pendingOps.delete(root);
    console.log(`[daemon] Watching ${root}`);
  }

  private async subscribeWatcher(
    root: string,
    processor: ProjectBatchProcessor,
  ): Promise<void> {
    const name = path.basename(root);

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
    this.deps.subscriptions.set(root, sub);
  }

  private recoverWatcher(root: string, processor: ProjectBatchProcessor): void {
    const name = path.basename(root);
    if (this.deps.getShuttingDown()) return;

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
        this.catchupScan(root, processor).catch((err) => {
          console.error(`[daemon:${name}] Poll catchup failed:`, err);
        });
        const interval = setInterval(() => {
          if (this.deps.getShuttingDown()) return;
          this.deps.touchActivity();
          this.catchupScan(root, processor).catch((err) => {
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
    const delayMs = 3000 * Math.pow(2, fails - 1);
    console.error(
      `[daemon:${name}] Recovering watcher (attempt ${fails}/${MAX_WATCHER_RETRIES}, backoff ${delayMs}ms)...`,
    );

    setTimeout(() => {
      if (this.deps.getShuttingDown()) {
        this.pendingOps.delete(recoveryKey);
        return;
      }
      (async () => {
        try {
          await this.subscribeWatcher(root, processor);
          const lastCatchup = this.lastCatchupEndMs.get(root) ?? 0;
          const CATCHUP_COOLDOWN_MS = 60_000;
          if (Date.now() - lastCatchup < CATCHUP_COOLDOWN_MS) {
            console.log(
              `[daemon:${name}] Skipping catchup scan (last completed ${Math.round((Date.now() - lastCatchup) / 1000)}s ago)`,
            );
          } else {
            await this.catchupScan(root, processor);
          }
          console.log(`[daemon:${name}] Watcher recovered`);
        } catch (err) {
          console.error(`[daemon:${name}] Watcher recovery failed:`, err);
        } finally {
          this.pendingOps.delete(recoveryKey);
        }
      })();
    }, delayMs);
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
        console.log(
          `[daemon:${name}] Attempting to leave poll mode and reattach FSEvents...`,
        );
        try {
          // Reset failure counter so subscribeWatcher's error path treats this
          // as a fresh start. If it fails again, we'll fall right back into
          // poll mode via the same recoverWatcher path.
          this.watcherFailCount.delete(root);
          await this.subscribeWatcher(root, processor);

          // Wait one health window — if the new subscription survives without
          // another overflow, we consider it recovered and tear down poll mode.
          await new Promise((r) => setTimeout(r, FSEVENTS_HEALTH_WINDOW_MS));
          if (this.deps.getShuttingDown()) return;

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
  ): Promise<void> {
    const { walk } = await import("../index/walker");
    const { INDEXABLE_EXTENSIONS, MAX_FILE_SIZE_BYTES } = await import(
      "../../config"
    );
    const { isFileCached } = await import("../utils/cache-check");

    const metaCache = this.deps.getMetaCache()!;
    const rootPrefix = root.endsWith("/") ? root : `${root}/`;
    const cachedPaths = await metaCache.getKeysWithPrefix(rootPrefix);
    const seenPaths = new Set<string>();

    let queued = 0;
    let skipped = 0;
    let debugSamples = 0;
    for await (const relPath of walk(root, {
      additionalPatterns: ["**/.git/**", "**/.gmax/**"],
    })) {
      const absPath = path.join(root, relPath);
      const ext = path.extname(absPath).toLowerCase();
      const bn = path.basename(absPath).toLowerCase();
      if (!INDEXABLE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(bn))
        continue;

      seenPaths.add(absPath);

      try {
        const stats = await fs.promises.stat(absPath);
        // Skip files that are too large or empty — they'll never be indexed
        if (stats.size === 0 || stats.size > MAX_FILE_SIZE_BYTES) continue;
        const cached = metaCache.get(absPath);
        if (!isFileCached(cached, stats)) {
          // Fast path: if only mtime changed but size is identical and we have a hash,
          // just verify the hash in-process instead of sending to a worker.
          if (cached && cached.hash && cached.size === stats.size) {
            const { computeBufferHash } = await import("../utils/file-utils");
            const buf = await fs.promises.readFile(absPath);
            const hash = computeBufferHash(buf);
            if (hash === cached.hash) {
              // Content unchanged — update mtime in cache and skip worker
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
          processor.handleFileEvent("change", absPath);
          queued++;

          // Throttle: pause periodically during large catchup scans to let the
          // batch processor drain and compaction run between bursts.
          if (queued % 500 === 0) {
            dbg(
              "catchup",
              `${path.basename(root)}: throttle pause at ${queued} queued`,
            );
            await new Promise((r) => setTimeout(r, 5_000));
          }
        } else {
          skipped++;
        }
      } catch {}
    }
    dbg(
      "catchup",
      `${path.basename(root)}: ${queued} queued, ${skipped} skipped (cached ok), ${seenPaths.size} total`,
    );

    // Purge files deleted while daemon was offline
    let purged = 0;
    for (const cachedPath of cachedPaths) {
      if (!seenPaths.has(cachedPath)) {
        processor.handleFileEvent("unlink", cachedPath);
        purged++;
      }
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
  }

  async unwatchProject(root: string): Promise<void> {
    const processor = this.deps.processors.get(root);
    if (!processor) return;

    await processor.close();

    const sub = this.deps.subscriptions.get(root);
    if (sub) {
      await sub.unsubscribe();
      this.deps.subscriptions.delete(root);
    }

    this.deps.processors.delete(root);
    this.deps.evictSearcher(root);
    this.lastOverflowMs.delete(root);
    this.lastCatchupEndMs.delete(root);
    unregisterWatcherByRoot(root);

    console.log(`[daemon] Unwatched ${root}`);
  }

  /**
   * Stop all poll intervals + their FSEvents recovery probes and unsubscribe
   * every watcher. Called from the daemon's shutdown after the worker pool is
   * destroyed (the subscriptions map is shared, so it is cleared here).
   */
  async teardown(): Promise<void> {
    for (const interval of this.pollIntervals.values()) {
      clearInterval(interval);
    }
    this.pollIntervals.clear();
    for (const interval of this.pollRecoveryTimers.values()) {
      clearInterval(interval);
    }
    this.pollRecoveryTimers.clear();

    for (const sub of this.deps.subscriptions.values()) {
      try {
        await sub.unsubscribe();
      } catch {}
    }
    this.deps.subscriptions.clear();
  }
}
