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

function isProcessGroupRunning(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function terminateProcessGroup(
  pgid: number,
  options: { termTimeoutMs?: number; killTimeoutMs?: number } = {},
): Promise<boolean> {
  const termTimeoutMs = options.termTimeoutMs ?? 3_000;
  const killTimeoutMs = options.killTimeoutMs ?? 1_000;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return false;
  }

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    const attempts = Math.max(1, Math.ceil(timeoutMs / 100));
    for (let i = 0; i < attempts; i++) {
      if (!isProcessGroupRunning(pgid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !isProcessGroupRunning(pgid);
  };

  if (await waitForExit(termTimeoutMs)) return true;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  return waitForExit(killTimeoutMs);
}
