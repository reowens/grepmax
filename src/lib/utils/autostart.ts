import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import { safetyStopReason } from "./safety-latch";

/**
 * Kill switch for *implicit* daemon auto-start. Create
 * ~/.gmax/autostart-disabled (or export GMAX_NO_AUTOSTART=1) to keep session
 * hooks and ordinary commands (`gmax add`, `gmax index`, search, MCP) from
 * reviving the daemon — needed when the host is quarantined and the daemon's
 * write volume is the thing under investigation.
 *
 * Safety containment also gates explicit daemon launches. A launch is not
 * authorization to remove an existing host quarantine.
 *
 * plugins/grepmax/hooks/watch-lease.js carries a plain-JS copy of these semantics
 * (env var checked first, then the file) because a SessionStart hook cannot
 * import from dist. Keep the two in sync.
 */
export function autostartDisabledReason(): "env" | "file" | "safety" | null {
  if (process.env.GMAX_NO_AUTOSTART === "1") return "env";
  if (safetyStopReason() !== null) return "safety";
  const markers = new Set([
    PATHS.autostartDisabledFile,
    ...(PATHS.sharedRoot
      ? [path.join(PATHS.sharedRoot, "autostart-disabled")]
      : []),
  ]);
  for (const marker of markers) {
    try {
      fs.lstatSync(marker);
      return "file";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "file";
    }
  }
  return null;
}

export function isAutostartDisabled(): boolean {
  return autostartDisabledReason() !== null;
}

export function daemonStartDeniedReason(): string | null {
  const safety = safetyStopReason();
  if (safety !== null) return `host safety stop: ${safety}`;
  return isAutostartDisabled() ? "daemon startup is quarantined" : null;
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
  if (reason === "safety")
    return "review the persistent host safety stop before resuming";
  return reason === "env"
    ? "unset GMAX_NO_AUTOSTART"
    : `rm ${PATHS.autostartDisabledFile}`;
}

export function autostartDisabledNotice(): string | null {
  const safety = safetyStopReason();
  if (safety !== null)
    return `Gmax is paused by a persistent host safety stop: ${safety}. Mutations remain blocked until containment is reviewed.`;
  // A secondary store (src/bin.ts) runs in-process by design, not because the
  // kill switch is on, so say that instead of naming an undo step. Callers use
  // a non-null notice as the gate, so this must stay non-null.
  if (process.env.GMAX_SECONDARY_STORE === "1") {
    return `This project's index lives in ${PATHS.globalRoot} on an external drive — running in-process, not watched. Run \`gmax index\` after changing it.`;
  }
  const undo = autostartDisabledUndo();
  if (!undo) return null;
  return `Daemon autostart is disabled — running in-process. Re-enable with: ${undo}`;
}
