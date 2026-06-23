/**
 * Query-time staleness nudge.
 *
 * When a graph/search command resolves a project whose index was built by an
 * older chunker than the current one, emit a single concise line to STDERR.
 * Writing to stderr (never stdout) keeps `--json` / `--agent` machine output
 * byte-identical — agents parse stdout, so the hint never pollutes it. In
 * `--agent` mode the line is rendered as a structured TSV record instead of
 * prose so a tool that *does* capture stderr can parse it.
 *
 * Fires at most once per process. Suppress entirely with GMAX_NO_STALE_HINT=1.
 */
import { describeChunkerGap } from "../../config";
import { getProject } from "./project-registry";

let emitted = false;

/** Reset the once-per-process latch. Test-only. */
export function _resetStaleHintForTests(): void {
  emitted = false;
}

export function maybeWarnStaleChunker(
  projectRoot: string | null | undefined,
  opts?: { agent?: boolean },
): void {
  if (emitted) return;
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
  emitted = true;

  const name = project.name || projectRoot;

  if (opts?.agent) {
    process.stderr.write(
      [
        "stale_chunker",
        `project=${name}`,
        `indexed_v=${gap.fromVersion}`,
        `current_v=${gap.toVersion}`,
        `severity=${gap.severity}`,
        `note=${gap.notes.join("; ")}`,
        "fix=gmax index --reset",
      ].join("\t") + "\n",
    );
    return;
  }

  const label = gap.severity === "breaking" ? "WARN" : "hint";
  process.stderr.write(
    `${label}  gmax: '${name}' indexed by chunker v${gap.fromVersion} (now v${gap.toVersion}) — ${gap.notes.join(" ")} Run 'gmax index --reset' to refresh. (silence: GMAX_NO_STALE_HINT=1)\n`,
  );
}
