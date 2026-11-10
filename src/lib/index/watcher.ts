import type { IndexState, WatchQueueState } from "../output/index-state-footer";
import type { MetaCache } from "../store/meta-cache";
import type { VectorDB } from "../store/vector-db";
import { ProjectBatchProcessor } from "./batch-processor";
import { reconcileMetaEntry } from "./cache-coherence";
import { ProjectFilePolicy } from "./file-policy";
import { reconcileProject, WatcherSubscription } from "./watcher-core";
import { FSEVENTS_GAP_SCAN_INTERVAL_MS } from "./watcher-errors";
import { WatcherRecoveryTracker } from "./watcher-recovery";

export interface WatcherHandle {
  close: () => Promise<void>;
  readonly health: IndexState;
  readonly progress: {
    pendingFiles: number;
    processing: boolean;
    failedFiles: number;
    queue: WatchQueueState;
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

export { WATCHER_IGNORE_GLOBS } from "./watcher-core";

export async function startWatcher(
  opts: WatcherOptions,
): Promise<WatcherHandle> {
  const { projectRoot } = opts;
  const wtag = `watch:${projectRoot.split("/").pop()}`;

  const filePolicy = new ProjectFilePolicy(projectRoot);
  const recovery = new WatcherRecoveryTracker();
  let reconciliation: Promise<void> | null = null;
  let reconcileRequested = false;
  let closing = false;
  let scanHealthy = (opts.initialScanErrors ?? 0) === 0;
  let ingestionDegraded = (opts.initialFailedFiles ?? 0) > 0;
  let degradedRepairQueued = false;
  const terminalFailures = new Set<string>();
  let processor!: ProjectBatchProcessor;
  let gapScanTimer: ReturnType<typeof setTimeout> | undefined;
  let lastReconcileStart: number | undefined;
  let gapGeneration = 0;
  const subscription = new WatcherSubscription({
    root: projectRoot,
    recovery,
    isActive: () => !closing,
    onError: (err) => {
      console.error(`[${wtag}] Watcher error:`, err);
      scanHealthy = false;
      opts.onHealthChange?.(false, 1);
      gapGeneration++;
    },
    onGap: () => requestGapScan(),
    onTerminal: () => reconcile(),
    onRetry: (err, vanished, delayMs) =>
      console.error(
        `[${wtag}] Subscribe failed on vanished path ${vanished || "(not reported)"}, retrying in ${delayMs / 1000}s (${err.message})`,
      ),
    onEvents: (events) => {
      for (const event of events)
        processor.handleFileEvent(
          event.type === "delete" ? "unlink" : "change",
          event.path,
        );
    },
  });
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
        lastReconcileStart = Date.now();
        const observedGapGeneration = gapGeneration;
        const scan = recovery.beginScan();
        let outcome: "complete" | "incomplete" | "failed" = "failed";
        let retryDelayMs = 0;
        try {
          filePolicy.invalidateIgnoreCache();
          await subscription.update();
          if (closing) return;
          const result = await reconcileProject({
            root: projectRoot,
            policy: filePolicy,
            processor,
            metaCache: opts.metaCache,
            vectorDb: opts.vectorDb,
            aborted: () => closing,
            visit: async ({ absolute, vectorPaths }) => {
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
                workKind: "catchup",
              });
              return true;
            },
          });
          if (!result) return;
          const { state } = result;
          if (!state.rootComplete || state.errors.length > 0) {
            outcome = "incomplete";
            scanHealthy = false;
            opts.onHealthChange?.(false, state.errors.length);
            console.error(
              `[${wtag}] Reconciliation incomplete at ${state.errors.length} path(s)`,
            );
            if (incompleteRetries < 3) {
              incompleteRetries++;
              reconcileRequested = true;
              retryDelayMs = 1000 * 2 ** (incompleteRetries - 1);
            }
          } else {
            outcome = "complete";
            scanHealthy = observedGapGeneration === gapGeneration;
            if (ingestionDegraded && processor.progress.pendingFiles > 0) {
              degradedRepairQueued = true;
            }
            reportHealthyIfSettled();
            incompleteRetries = 0;
          }
        } finally {
          recovery.finishScan(scan, closing ? "aborted" : outcome);
        }
        if (retryDelayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      } while (reconcileRequested && !closing);
    })()
      .catch((err) => console.error(`[${wtag}] Reconciliation failed:`, err))
      .finally(() => {
        reconciliation = null;
      });
  };
  const requestGapScan = () => {
    if (closing || gapScanTimer) return;
    const remaining =
      lastReconcileStart === undefined
        ? 0
        : FSEVENTS_GAP_SCAN_INTERVAL_MS - (Date.now() - lastReconcileStart);
    if (reconciliation || remaining > 0) {
      gapScanTimer = setTimeout(
        () => {
          gapScanTimer = undefined;
          reconcile();
        },
        Math.max(remaining, FSEVENTS_GAP_SCAN_INTERVAL_MS),
      );
      return;
    }
    reconcile();
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

  await subscription.update();
  reconcile();

  return {
    get health(): IndexState {
      const progress = processor.progress;
      const state = recovery.snapshot();
      return {
        indexing: progress.processing || progress.pendingFiles > 0,
        pendingFiles: progress.pendingFiles,
        queue: progress.queue,
        failedFiles: Math.max(terminalFailures.size, progress.failedFiles),
        degraded:
          !scanHealthy || ingestionDegraded || terminalFailures.size > 0,
        watcherMode: closing
          ? undefined
          : subscription.failed || gapScanTimer || state.reconciliationNeeded
            ? "recovering"
            : "native",
        catchupRunning: reconciliation !== null,
        watcherRecovery: state,
      };
    },
    get progress() {
      return processor.progress;
    },
    close: async () => {
      closing = true;
      subscription.retire();
      clearTimeout(gapScanTimer);
      await subscription.settled();
      await subscription.detach();
      await reconciliation;
      await processor.close();
    },
  };
}
