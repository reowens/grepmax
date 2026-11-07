import { destroyWorkerPool, isWorkerPoolInitialized } from "../workers/pool";
import { runCleanup } from "./cleanup";

const EXIT_TIMEOUT_MS = 8_000;

/**
 * With `bySignal`, the process ends by that signal's default action instead of
 * process.exit. process.exit joins libuv's threadpool, so it waits for native
 * work still running there, such as a file watcher subscribe crawling a large
 * tree (31 s measured). A service manager counts SIGTERM and SIGINT as a clean
 * stop.
 */
export async function gracefulExit(
  code?: number,
  options: { bySignal?: NodeJS.Signals } = {},
): Promise<void> {
  const finalCode =
    typeof code === "number"
      ? code
      : typeof process.exitCode === "number"
        ? process.exitCode
        : 0;

  // Safety net: force-exit if cleanup hangs
  const forceTimer =
    !process.env.VITEST && process.env.NODE_ENV !== "test"
      ? setTimeout(() => process.exit(finalCode), EXIT_TIMEOUT_MS)
      : undefined;
  if (forceTimer) forceTimer.unref();

  try {
    if (isWorkerPoolInitialized()) {
      await destroyWorkerPool();
    }
  } catch (err) {
    console.error("[exit] Failed to destroy worker pool:", err);
  }

  await runCleanup();

  if (forceTimer) clearTimeout(forceTimer);

  // Avoid exiting the process during test runs so Vitest can report results.
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    process.exitCode = finalCode;
    return;
  }

  if (options.bySignal) {
    process.removeAllListeners(options.bySignal);
    process.kill(process.pid, options.bySignal);
    return;
  }
  process.exit(finalCode);
}
