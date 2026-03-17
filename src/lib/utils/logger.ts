const VERBOSE =
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
