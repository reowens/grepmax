const configuredTimeout = Number(process.env.GMAX_QUERY_TIMEOUT_MS);
export const QUERY_TIMEOUT_MS =
  Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.max(1, Math.min(Math.floor(configuredTimeout), 2_147_483_647))
    : 15_000;
export const QUERY_EXECUTION_OPTIONS = { timeoutMs: QUERY_TIMEOUT_MS };

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
 * This JavaScript backstop does not cancel its input. Native query callers
 * must also pass QUERY_EXECUTION_OPTIONS to toArray/execute so Lance enforces
 * an execution deadline. The historical 0.27 LIKE+limit hang has a native
 * temporary-store regression on the pinned SDK.
 */
export async function withQueryTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms = QUERY_TIMEOUT_MS,
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

/** Stream bounded Arrow batches with a native and overall wall-clock deadline.
 * SDK 0.38 exposes execute(options) at runtime but marks it protected in its
 * declarations. Keep this version-specific adapter here and cover it natively.
 */
export async function* streamQueryRows(
  query: unknown,
  label: string,
  ms = QUERY_TIMEOUT_MS,
): AsyncGenerator<any> {
  const streaming = query as {
    execute(options: {
      timeoutMs: number;
      maxBatchLength: number;
    }): AsyncIterator<{
      toArray(): any[];
    }>;
  };
  const iterator = streaming.execute({ timeoutMs: ms, maxBatchLength: 512 });
  const deadline = Date.now() + ms;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new QueryTimeoutError(label, ms);
      const batch = await withQueryTimeout(iterator.next(), label, remaining);
      if (batch.done) return;
      for (const row of batch.value.toArray()) yield row;
    }
  } finally {
    // Do not let a broken native iterator's pending next() hang cleanup.
    void iterator.return?.().catch(() => {});
  }
}
