import { isProcessRunning } from "./watcher-store";

/**
 * Send SIGTERM, wait up to 3s, then SIGKILL if still alive.
 * Returns true if process is confirmed dead.
 */
export async function killProcess(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  // Poll up to 3s for graceful exit
  for (let i = 0; i < 30; i++) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch {}

  // Give SIGKILL a moment
  for (let i = 0; i < 10; i++) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }

  return !isProcessRunning(pid);
}
