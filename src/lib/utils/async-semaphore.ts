/**
 * Counting semaphore with abortable waits, plus a bounded-concurrency map.
 *
 * The daemon serves every MCP session over one socket, and some read verbs are
 * full-table scans whose Arrow buffers live in native memory. Without a cap,
 * N sessions asking at once means N scans resident at once — the footprint that
 * froze a 48 GB machine at 9.6 GB. The semaphore bounds how many run; a waiter
 * whose client disconnects leaves the queue instead of running for nobody.
 */

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class AsyncSemaphore {
  private available: number;
  private readonly queue: Waiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`semaphore capacity must be >= 1, got ${capacity}`);
    }
    this.available = capacity;
  }

  /** Slots currently held. */
  get active(): number {
    return this.capacity - this.available;
  }

  /** Callers waiting for a slot. */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Resolve with a release function once a slot is free. Rejects with an
   * AbortError if `signal` fires first; the waiter is removed from the queue,
   * so an abandoned request never takes a slot.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => resolve(this.releaser()),
        reject,
        signal,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  /** Run `fn` while holding a slot; the slot is released however `fn` ends. */
  async run<T>(
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        // Hand the slot straight to the next waiter; `available` is unchanged.
        if (next.onAbort) {
          next.signal?.removeEventListener("abort", next.onAbort);
        }
        next.resolve();
        return;
      }
      this.available++;
    };
  }
}

/**
 * `Promise.all(items.map(fn))` with at most `limit` calls in flight, results in
 * input order. Once `signal` aborts no new item starts, and the call rejects
 * with the abort after the in-flight ones settle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      if (signal?.aborted) {
        failure = { error: abortError(signal.reason) };
        return;
      }
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}
