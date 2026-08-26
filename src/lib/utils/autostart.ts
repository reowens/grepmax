import * as fs from "node:fs";
import { PATHS } from "../../config";

/**
 * Kill switch for *implicit* daemon auto-start. Create
 * ~/.gmax/autostart-disabled (or export GMAX_NO_AUTOSTART=1) to keep session
 * hooks and ordinary commands (`gmax add`, `gmax index`, search, MCP) from
 * reviving the daemon — needed when the host is quarantined and the daemon's
 * write volume is the thing under investigation.
 *
 * Explicit `gmax watch --daemon` is never gated: typing it is the user asking
 * for a daemon in that moment.
 *
 * plugins/grepmax/hooks/start.js carries a plain-JS copy of these semantics
 * (env var checked first, then the file) because a SessionStart hook cannot
 * import from dist. Keep the two in sync.
 */
export function autostartDisabledReason(): "env" | "file" | null {
  if (process.env.GMAX_NO_AUTOSTART === "1") return "env";
  try {
    return fs.existsSync(PATHS.autostartDisabledFile) ? "file" : null;
  } catch {
    return null;
  }
}

export function isAutostartDisabled(): boolean {
  return autostartDisabledReason() !== null;
}

/**
 * One-line notice for commands that fell back to in-process work because the
 * kill switch is on, or null when it isn't. Names the specific undo step so
 * the message is actionable whichever way autostart was disabled.
 */
/** The shell command that re-enables autostart, or null when it is not disabled. */
export function autostartDisabledUndo(): string | null {
  const reason = autostartDisabledReason();
  if (!reason) return null;
  return reason === "env"
    ? "unset GMAX_NO_AUTOSTART"
    : `rm ${PATHS.autostartDisabledFile}`;
}

export function autostartDisabledNotice(): string | null {
  const undo = autostartDisabledUndo();
  if (!undo) return null;
  return `Daemon autostart is disabled — running in-process. Re-enable with: ${undo}`;
}
