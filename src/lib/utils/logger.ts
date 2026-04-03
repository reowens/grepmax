export const VERBOSE =
  process.env.GMAX_DEBUG === "1" || process.env.GMAX_VERBOSE === "1";

export function log(tag: string, msg: string): void {
  process.stderr.write(`[${tag}] ${msg}\n`);
}

export function debug(tag: string, msg: string): void {
  if (VERBOSE) process.stderr.write(`[${tag}] ${msg}\n`);
}

export function timer(tag: string, label: string): () => void {
  const start = Date.now();
  return () => {
    const ms = Date.now() - start;
    const elapsed =
      ms > 60000
        ? `${(ms / 60000).toFixed(1)}min`
        : `${(ms / 1000).toFixed(1)}s`;
    log(tag, `${label}: ${elapsed}`);
  };
}

/**
 * Returns a stop function that logs elapsed time at debug level.
 * No-ops when GMAX_DEBUG is off. Uses performance.now() for sub-ms precision.
 */
export function debugTimer(tag: string, label: string): () => void {
  if (!VERBOSE) return () => {};
  const start = performance.now();
  return () => {
    const ms = performance.now() - start;
    debug(tag, `${label}: ${ms.toFixed(1)}ms`);
  };
}

/**
 * Creates a rate-limited debug logger that only emits every `interval` calls.
 * Useful for per-file progress in loops with thousands of iterations.
 */
export function debugEvery(
  tag: string,
  interval: number,
): (msg: string) => void {
  if (!VERBOSE) return () => {};
  let count = 0;
  return (msg: string) => {
    count++;
    if (count % interval === 0) {
      debug(tag, msg);
    }
  };
}
