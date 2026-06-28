/**
 * Query-time staleness nudges.
 *
 * When a graph/search command resolves a project whose index is out of date —
 * built by an older chunker, or with a different embedding model/dim than the
 * current config — emit a single concise line to STDERR. Writing to stderr
 * (never stdout) keeps `--json` / `--agent` machine output byte-identical —
 * agents parse stdout, so the hint never pollutes it. In `--agent` mode the line
 * is rendered as a structured TSV record instead of prose so a tool that *does*
 * capture stderr can parse it.
 *
 * Each concern fires at most once per process (independent latches, so a stale
 * chunker does not mask a stale embedding). Suppress all with GMAX_NO_STALE_HINT=1.
 */
import {
  CONFIG,
  DEFAULT_MODEL_TIER,
  describeChunkerGap,
  describeEmbeddingGap,
  MODEL_TIERS,
  REBUILD_COMMAND,
} from "../../config";
import { readGlobalConfig } from "../index/index-config";
import { getProject, listProjects } from "./project-registry";

let chunkerEmitted = false;
let embeddingEmitted = false;
let crossDimEmitted = false;

/** Reset the once-per-process latches. Test-only. */
export function _resetStaleHintForTests(): void {
  chunkerEmitted = false;
  embeddingEmitted = false;
  crossDimEmitted = false;
}

export function maybeWarnStaleChunker(
  projectRoot: string | null | undefined,
  opts?: { agent?: boolean },
): void {
  if (chunkerEmitted) return;
  if (!projectRoot) return;
  if (process.env.GMAX_NO_STALE_HINT === "1") return;

  const project = getProject(projectRoot);
  // Only nudge for an index that is supposed to be complete. A "pending"
  // project is mid-index (will land current); "error" is ignored by the
  // daemon; an unregistered root would already have errored upstream.
  if (!project) return;
  if (project.status && project.status !== "indexed") return;

  const gap = describeChunkerGap(project.chunkerVersion);
  if (!gap) return;

  // Latch only once we have something to say, so a suppressed-by-status call
  // does not silence a later command in the same process (CLI is one command
  // per process, but search resolves the root in two places).
  chunkerEmitted = true;

  const name = project.name || projectRoot;

  if (opts?.agent) {
    const fields = [
      "stale_chunker",
      `project=${name}`,
      `indexed_v=${gap.fromVersion}`,
      `current_v=${gap.toVersion}`,
      `severity=${gap.severity}`,
      `note=${gap.notes.join("; ")}`,
      "fix=gmax index --reset",
    ].join("\t");
    process.stderr.write(`${fields}\n`);
    return;
  }

  const label = gap.severity === "breaking" ? "WARN" : "hint";
  process.stderr.write(
    `${label}  gmax: '${name}' indexed by chunker v${gap.fromVersion} (now v${gap.toVersion}) — ${gap.notes.join(" ")} Run 'gmax index --reset' to refresh. (silence: GMAX_NO_STALE_HINT=1)\n`,
  );
}

/**
 * Nudge when a project's stored embedding model/dim differs from the current
 * global config. A dim change is `breaking` (search scores are invalid until a
 * re-embed); a same-dim model swap is `additive` (results just mix models).
 * Mirrors maybeWarnStaleChunker's discipline: stderr-only, once-per-process,
 * `--agent` TSV, GMAX_NO_STALE_HINT-suppressible.
 */
export function maybeWarnStaleEmbedding(
  projectRoot: string | null | undefined,
  opts?: { agent?: boolean },
): void {
  if (embeddingEmitted) return;
  if (!projectRoot) return;
  if (process.env.GMAX_NO_STALE_HINT === "1") return;

  const project = getProject(projectRoot);
  if (!project) return;
  if (project.status && project.status !== "indexed") return;

  const current = readGlobalConfig();
  const gap = describeEmbeddingGap(
    { modelTier: project.modelTier, vectorDim: project.vectorDim },
    { modelTier: current.modelTier, vectorDim: current.vectorDim },
  );
  if (!gap) return;

  embeddingEmitted = true;

  const name = project.name || projectRoot;

  if (opts?.agent) {
    const fields = [
      "stale_embedding",
      `project=${name}`,
      `indexed_model=${gap.fromModel}`,
      `current_model=${gap.toModel}`,
      `indexed_dim=${gap.fromDim}`,
      `current_dim=${gap.toDim}`,
      `dim_changed=${gap.dimChanged}`,
      `severity=${gap.severity}`,
      // A dim change needs the global rebuild (shared table is fixed-width); a
      // same-dim model swap can use a per-project reset.
      `fix=${gap.dimChanged ? REBUILD_COMMAND : "gmax index --reset"}`,
    ].join("\t");
    process.stderr.write(`${fields}\n`);
    return;
  }

  const label = gap.severity === "breaking" ? "WARN" : "hint";
  const detail = gap.dimChanged
    ? `vector dim ${gap.fromDim}→${gap.toDim} (incompatible — scores invalid until re-embed)`
    : `model '${gap.fromModel}'→'${gap.toModel}' (same dim; results mix models until re-embed)`;
  const fix = gap.dimChanged
    ? `Run '${REBUILD_COMMAND}'`
    : "Run 'gmax index --reset'";
  process.stderr.write(
    `${label}  gmax: '${name}' indexed with embedding ${detail}. ${fix}. (silence: GMAX_NO_STALE_HINT=1)\n`,
  );
}

/**
 * Cross-project guard: when a `--all-projects` / `--projects` search spans
 * projects whose stored vector widths disagree (with each other or with the
 * current query width), the shared fixed-dim table cannot answer all of them
 * correctly — mismatched vectors were padded/truncated at insert and score as
 * noise. Warn (stderr) so the caller can re-embed or exclude them, rather than
 * silently returning invalid cross-project rankings.
 */
export function maybeWarnCrossProjectDim(
  roots: { root: string; name: string }[],
  opts?: { agent?: boolean },
): void {
  if (crossDimEmitted) return;
  if (process.env.GMAX_NO_STALE_HINT === "1") return;
  if (!roots || roots.length === 0) return;

  const current = readGlobalConfig();
  const currentDim =
    current.vectorDim ??
    MODEL_TIERS[current.modelTier ?? DEFAULT_MODEL_TIER]?.vectorDim ??
    CONFIG.VECTOR_DIM;

  const byRoot = new Map(listProjects().map((p) => [p.root, p]));
  const dims = new Set<number>([currentDim]);
  const mismatched: { name: string; dim: number }[] = [];
  for (const r of roots) {
    const p = byRoot.get(r.root);
    if (!p) continue;
    const dim =
      p.vectorDim ?? MODEL_TIERS[p.modelTier]?.vectorDim ?? currentDim;
    dims.add(dim);
    if (dim !== currentDim) mismatched.push({ name: p.name || r.name, dim });
  }

  // All in-scope projects share the query width → nothing to warn about.
  if (dims.size <= 1) return;

  crossDimEmitted = true;

  if (opts?.agent) {
    const fields = [
      "stale_embedding_crossdim",
      `query_dim=${currentDim}`,
      `mismatched=${mismatched.map((m) => `${m.name}:${m.dim}`).join(",")}`,
      "fix=re-embed or --exclude-projects",
    ].join("\t");
    process.stderr.write(`${fields}\n`);
    return;
  }

  const list = mismatched.map((m) => `${m.name} (${m.dim}d)`).join(", ");
  process.stderr.write(
    `WARN  gmax: cross-project search mixes embedding dims (query ${currentDim}d) — ${list} return invalid scores. Re-embed them or drop with --exclude-projects. (silence: GMAX_NO_STALE_HINT=1)\n`,
  );
}
