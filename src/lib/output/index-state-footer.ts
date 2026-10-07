// Phase 6 — partial-index signal for agent-mode search.
//
// During the catchup window the index is incomplete but search still returns
// (partial) results. Non-agent output already warns about this; agent output
// historically did not. This formats a single machine-readable footer so an
// agent can decide to caveat its answer or retry once indexing settles.

export type WatchWorkKind = "live" | "catchup" | "cleanup";

export interface WatchQueueState {
  /** Waiting paths only; active files are reported separately. */
  live: number;
  catchup: number;
  cleanup: number;
  activeFiles: number;
  /** Includes active live edits until their batch commits. */
  oldestLiveEditAgeMs: number | null;
}

export interface IndexState {
  /** A batch is running, files are queued, or the initial index isn't done. */
  indexing: boolean;
  /** Files queued for (re)index. 0 when unknown (e.g. initial sync) or settled. */
  pendingFiles: number;
  queue?: WatchQueueState;
  /**
   * Recent batches were cache hits. Pending files still need verification;
   * this sample cannot establish that the remaining queue is unchanged.
   */
  verifying?: boolean;
  failedFiles?: number;
  degraded?: boolean;
  watcherMode?: "native" | "polling" | "recovering";
  catchupRunning?: boolean;
  lastReconciledAt?: number;
  overflowCount?: number;
  catchupMs?: number;
}

export function formatWatchQueue(queue: WatchQueueState): string {
  const age =
    queue.oldestLiveEditAgeMs === null
      ? "none"
      : `${Math.ceil(queue.oldestLiveEditAgeMs / 1000)}s`;
  return `live=${queue.live} catchup=${queue.catchup} cleanup=${queue.cleanup} active=${queue.activeFiles} oldestLiveEdit=${age}`;
}

/**
 * One-line footer describing an in-progress index, or null when there's
 * nothing to say (no state, or the index is settled). Suppressing the
 * settled case keeps steady-state search silent — the footer only appears
 * while results may actually be incomplete.
 */
export function formatIndexStateFooter(
  state: IndexState | undefined,
  opts: { agent: boolean },
): string | null {
  if (!state) return null;
  const issues: string[] = [];
  if (state.failedFiles) issues.push(`${state.failedFiles} files failed`);
  if (state.degraded && !state.failedFiles)
    issues.push("reconciliation incomplete");
  if (state.watcherMode === "polling")
    issues.push("polling; changes may lag up to 5min");
  if (state.watcherMode === "recovering") issues.push("watcher recovering");
  if (state.catchupRunning) issues.push("reconciling filesystem changes");
  if (issues.length) {
    const next =
      state.failedFiles || state.degraded
        ? "inspect gmax watch status; retry after recovery"
        : "retry after reconciliation";
    return opts.agent
      ? `[index: ${issues.join(" · ")} · results may be incomplete · ${next}]`
      : `Index: ${issues.join("; ")} — results may be incomplete; ${next}.`;
  }
  if (!state.indexing) return null;

  // Cache-hit samples suggest verification, but do not prove the remaining
  // files are unchanged. Keep that distinction without claiming full coverage.
  if (state.verifying) {
    const n = state.pendingFiles;
    if (opts.agent) {
      return `[index: verifying ~${n} files · coverage not yet verified]`;
    }
    return `Index verifying ${n} file${n === 1 ? "" : "s"} — coverage is not yet verified.`;
  }

  const count =
    state.pendingFiles > 0 ? `~${state.pendingFiles} files pending` : null;

  if (opts.agent) {
    const parts = ["index: syncing"];
    if (count) parts.push(count);
    parts.push("results may be incomplete — retry for full coverage");
    return `[${parts.join(" · ")}]`;
  }

  const detail = count ? ` (${count})` : "";
  return `⚠️  Index still syncing${detail} — results may be incomplete.`;
}
