import { isUnknownCommandError } from "./store-access";

/**
 * Add manual next steps to recognized daemon failures at CLI rendering sites.
 * Keep the original reason, including any named exclusive operation. This does
 * not classify failures for fallback, retry, or change their exit status.
 */
export function formatCliErrorGuidance(message: string): string {
  // withStoreRead wraps daemon reasons; streaming commands expose them directly.
  const reason = message.replace(/^Daemon [a-z][a-z .-]* failed: /i, "");

  if (
    reason === "DAEMON_BUSY" ||
    reason === "daemon busy" ||
    reason.startsWith("daemon busy: exclusive operation ")
  ) {
    return `${message}\nNext: Check gmax status, wait for the exclusive operation to finish, then retry.`;
  }

  if (reason === "daemon initializing" || reason === "daemon not ready") {
    return `${message}\nNext: Wait for daemon startup to finish, check gmax status, then retry.`;
  }

  if (reason === "DAEMON_CLOSING" || reason === "daemon is closing") {
    return `${message}\nNext: Wait for daemon shutdown to finish, check gmax status, then retry.`;
  }

  if (isUnknownCommandError(reason)) {
    // Store-read failures already carry this recovery step; do not repeat it.
    if (message.includes("gmax watch restart")) return message;
    return `${message}\nNext: The live daemon does not support this command; run gmax watch restart to use the installed CLI version.`;
  }

  return message;
}
