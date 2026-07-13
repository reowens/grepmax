interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface KeyState {
  locked: boolean;
  queue: Waiter[];
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export class KeyedMutex {
  private readonly keys = new Map<string, KeyState>();
  private readonly activeTasks = new Set<Promise<unknown>>();
  private closed = false;

  get pending(): number {
    let count = 0;
    for (const state of this.keys.values()) {
      count += (state.locked ? 1 : 0) + state.queue.length;
    }
    return count;
  }

  run<T>(
    key: string,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const task = (async () => {
      await this.acquire(key, signal);
      try {
        if (signal?.aborted) throw abortError();
        return await fn();
      } finally {
        this.release(key);
      }
    })();
    this.activeTasks.add(task);
    const cleanup = () => this.activeTasks.delete(task);
    void task.then(cleanup, cleanup);
    return task;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [key, state] of this.keys) {
      for (const waiter of state.queue.splice(0)) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort!);
        waiter.reject(abortError());
      }
      if (!state.locked) this.keys.delete(key);
    }
    await Promise.allSettled([...this.activeTasks]);
  }

  private acquire(key: string, signal?: AbortSignal): Promise<void> {
    if (this.closed || signal?.aborted) return Promise.reject(abortError());
    const state = this.keys.get(key) ?? { locked: false, queue: [] };
    this.keys.set(key, state);
    if (!state.locked) {
      state.locked = true;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      const onAbort = () => {
        const index = state.queue.indexOf(waiter);
        if (index !== -1) state.queue.splice(index, 1);
        reject(abortError());
      };
      waiter.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      state.queue.push(waiter);
    });
  }

  private release(key: string): void {
    const state = this.keys.get(key);
    if (!state) return;
    const next = state.queue.shift();
    if (next) {
      next.signal?.removeEventListener("abort", next.onAbort!);
      next.resolve();
      return;
    }
    state.locked = false;
    this.keys.delete(key);
  }
}
