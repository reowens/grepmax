// Phase 6 — partial-index signal for agent-mode search.
//
// During the catchup window the index is incomplete but search still returns
// (partial) results. Non-agent output already warns about this; agent output
// historically did not. This formats a single machine-readable footer so an
// agent can decide to caveat its answer or retry once indexing settles.

export interface IndexState {
  /** A batch is running, files are queued, or the initial index isn't done. */
  indexing: boolean;
  /** Files queued for (re)index. 0 when unknown (e.g. initial sync) or settled. */
  pendingFiles: number;
  /**
   * The queue is draining as cache hits — recent batches reindexed nothing, so
   * the pending count is re-verification rather than outstanding work. Set only
   * with a real sample and no initial/full index in flight.
   */
  verifying?: boolean;
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
  if (!state?.indexing) return null;

  // Re-verification is not incompleteness. Saying "results may be incomplete"
  // while a catchup re-checks thousands of unchanged files trains agents to
  // distrust and retry correct answers, which is worse than saying nothing.
  if (state.verifying) {
    const n = state.pendingFiles;
    if (opts.agent) {
      return `[index: verifying ~${n} unchanged files · results current]`;
    }
    return `Index verifying ${n} unchanged file${n === 1 ? "" : "s"} — results are current.`;
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
