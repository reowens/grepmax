/**
 * Pure presentation helpers for `gmax doctor`. No I/O — callers do the probes
 * (fs existence, MLX/summarizer health) and pass the results in; these decide
 * the severity symbol and message. Kept out of doctor.ts so the severity logic
 * is unit-testable without spinning up the whole command or its dependencies.
 */

export type DoctorSymbol = "ok" | "WARN" | "FAIL" | "INFO";

export interface StatusLine {
  symbol: DoctorSymbol;
  message: string;
}

export interface MlxHealth {
  up: boolean;
  /** Model id reported by the /health endpoint, if reachable. */
  model?: string | null;
}

/**
 * ONNX model availability from the ~/.gmax/models/<id> dir. Correct for cpu-mode
 * embed models and for ColBERT (always ONNX in-worker). NOT correct for gpu-mode
 * embed models — those are served by MLX from the HF cache; use
 * {@link gpuEmbedModelStatus} for those.
 */
export function onnxModelStatus(id: string, exists: boolean): StatusLine {
  return exists
    ? { symbol: "ok", message: `${id}: downloaded` }
    : { symbol: "WARN", message: `${id}: will download on first use` };
}

/**
 * gpu-mode embed model availability, reported from reality rather than the ONNX
 * models dir (where MLX models never live). A live server is proof enough; a
 * down server falls back to the pinned HF cache to distinguish "cached, will
 * load on next start" from "not present, will download" — neither of which is a
 * warning, since the daemon respawns the server on demand.
 */
export function gpuEmbedModelStatus(
  id: string,
  health: MlxHealth,
  hfCacheExists: boolean,
): StatusLine {
  if (health.up) {
    return { symbol: "ok", message: `${id}: serving via MLX (port 8100)` };
  }
  if (hfCacheExists) {
    return {
      symbol: "ok",
      message: `${id}: cached (will load on next MLX start)`,
    };
  }
  return {
    symbol: "INFO",
    message: `${id}: will download on first MLX start`,
  };
}

/**
 * Summary coverage severity. The summarizer is an opt-in feature that has never
 * been enabled by default, so zero coverage is INFO (an unexercised opt-in), not
 * FAIL (which implies breakage and trains users/agents to ignore doctor FAILs).
 * Any partial coverage below 90% is a genuine WARN (a stalled/incomplete
 * backfill); >=90% is ok.
 */
export function summaryCoverageStatus(
  withSummary: number,
  totalChunks: number,
): StatusLine {
  const pct =
    totalChunks > 0 ? Math.round((withSummary / totalChunks) * 100) : 0;
  if (withSummary === 0) {
    return {
      symbol: "INFO",
      message: "Summary coverage: 0% (summarizer never enabled — opt-in)",
    };
  }
  const symbol: DoctorSymbol = pct >= 90 ? "ok" : "WARN";
  return {
    symbol,
    message: `Summary coverage: ${withSummary}/${totalChunks} (${pct}%)`,
  };
}

/**
 * Summarizer server presence. Being down is INFO, not WARN: the summarizer is
 * opt-in and, even when enabled, its llama-server idles out after 10min and
 * respawns on demand — a stopped server is the normal resting state.
 */
export function summarizerServerStatus(up: boolean): StatusLine {
  return up
    ? { symbol: "ok", message: "Summarizer: running (port 8101)" }
    : { symbol: "INFO", message: "Summarizer: not running (opt-in)" };
}
