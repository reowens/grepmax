export const VERBOSE =
  process.env.GMAX_DEBUG === "1" || process.env.GMAX_VERBOSE === "1";

/** Set by the daemon so forked workers (which share its log fd) opt in too. */
export const LOG_TIMESTAMPS_ENV = "GMAX_LOG_TIMESTAMPS";

/** Local time, same shape mlx-embed-server.log uses: 2026-07-06T21:33:26 */
function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Prefix a timestamp to each line in `text` that begins at line start.
 * `state.atLineStart` carries the position across chunks so a line split
 * over multiple write() calls is stamped exactly once. Blank lines are
 * left unstamped. Exported for tests.
 */
export function stampLines(
  text: string,
  state: { atLineStart: boolean },
): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf("\n", i);
    const end = nl === -1 ? text.length : nl + 1;
    const line = text.slice(i, end);
    if (state.atLineStart && line !== "\n") out += `${timestamp()} `;
    out += line;
    state.atLineStart = nl !== -1;
    i = end;
  }
  return out;
}

let timestampsInstalled = false;

/**
 * Prefix every stdout/stderr line with a local timestamp. Installed by the
 * daemon (whose stdio becomes daemon.log) and by workers when the daemon's
 * env flag is present — never by interactive CLI commands. Without this,
 * daemon.log lines can't be correlated with the timestamped MLX/LLM server
 * logs when reconstructing an incident.
 */
export function installTimestampedOutput(): void {
  if (timestampsInstalled) return;
  timestampsInstalled = true;
  process.env[LOG_TIMESTAMPS_ENV] = "1"; // forked workers inherit this
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream);
    const state = { atLineStart: true };
    stream.write = ((
      chunk: Parameters<typeof orig>[0],
      enc?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      const out =
        typeof chunk === "string" || Buffer.isBuffer(chunk)
          ? stampLines(chunk.toString(), state)
          : chunk;
      // Forward the (chunk, cb) and (chunk, enc, cb) overloads untouched.
      return orig(out as string, enc as BufferEncoding, cb);
    }) as typeof stream.write;
  }
}

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
