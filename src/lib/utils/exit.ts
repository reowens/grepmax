import { destroyWorkerPool, isWorkerPoolInitialized } from "../workers/pool";
import { runCleanup } from "./cleanup";

export async function gracefulExit(code = 0): Promise<void> {
  try {
    if (isWorkerPoolInitialized()) {
      await destroyWorkerPool();
    }
  } catch (err) {
    console.error("[exit] Failed to destroy worker pool:", err);
  }

  await runCleanup();

  // Avoid exiting the process during test runs so Vitest can report results.
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    process.exitCode = code;
    return;
  }

  process.exit(code);
}
