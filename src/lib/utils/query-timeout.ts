const DEFAULT_TIMEOUT_MS =
  Number(process.env.GMAX_QUERY_TIMEOUT_MS || "") || 15_000;

export class QueryTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(
      `LanceDB query timed out after ${ms}ms (${label}). ` +
        `The store may be busy or hitting a native scan bug — retry, or run: gmax doctor`,
    );
    this.name = "QueryTimeoutError";
  }
}

/**
 * Race a LanceDB query against a wall-clock timeout so a native-layer deadlock
 * surfaces as a loud error instead of hanging the process forever.
 *
 * Known trigger (@lancedb/lancedb 0.27.x): a `content LIKE` scan with
 * `.limit(N)` where more than N rows match never resolves — the limit-pushdown
 * cancellation loses the completion (see lancedb/lancedb#2189 for the same
 * family of hangs). Callers should also avoid that query shape (scan without
 * a limit and cap in JS); this wrapper is the backstop for shapes we missed.
 *
 * The timed-out native promise is NOT cancelled — its tokio task may stay
 * parked. CLI commands exit via gracefulExit() (process.exit), so the leak is
 * bounded to the command's lifetime. Long-lived callers (daemon) should treat
 * a QueryTimeoutError as a signal that the connection may be wedged.
 */
export async function withQueryTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueryTimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
