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
