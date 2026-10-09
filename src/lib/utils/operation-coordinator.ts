export class OperationBusyError extends Error {
  readonly code = "DAEMON_BUSY";

  constructor(operation: string) {
    super(`daemon busy: exclusive operation ${operation} is pending`);
    this.name = "OperationBusyError";
  }
}

export class OperationClosedError extends Error {
  readonly code = "DAEMON_CLOSING";

  constructor(message = "daemon is closing") {
    super(message);
    this.name = "OperationClosedError";
  }
}

type CoordinatorState =
  | { kind: "open" }
  | { kind: "exclusive-pending" | "exclusive"; name: string }
  | { kind: "closing" | "closed" };

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export class OperationCoordinator {
  private state: CoordinatorState = { kind: "open" };
  private readonly controllers = new Set<AbortController>();
  private readonly activeTasks = new Set<Promise<unknown>>();
  private readonly sharedTasks = new Set<Promise<unknown>>();
  private readonly taskNames = new Map<Promise<unknown>, string>();
  private closePromise: Promise<void> | null = null;
  private queueShared = false;
  private readWindow: ((name: string) => boolean) | undefined;
  private readonly waiters = new Set<{
    name: string;
    resume: () => void;
    reject: (error: Error) => void;
  }>();

  get status(): CoordinatorState["kind"] {
    return this.state.kind;
  }

  get activeCount(): number {
    return this.activeTasks.size;
  }

  /** Names of admitted operations that have not settled — for shutdown diagnostics. */
  activeOperationNames(): string[] {
    return [...this.activeTasks].map((task) => this.taskNames.get(task) ?? "?");
  }

  runShared<T>(
    name: string,
    signal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (
      this.queueShared &&
      (this.state.kind === "exclusive" ||
        this.state.kind === "exclusive-pending") &&
      !this.readWindow?.(name) &&
      !name.startsWith("watch") &&
      name !== "store-maintenance"
    ) {
      if (this.waiters.size >= 64)
        return Promise.reject(new OperationBusyError(this.state.name));
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      return new Promise<T>((resolve, reject) => {
        const cleanup = () => {
          this.waiters.delete(waiter);
          signal?.removeEventListener("abort", abort);
        };
        const waiter = {
          name,
          resume: () => {
            cleanup();
            resolve(this.runShared(name, signal, fn));
          },
          reject: (error: Error) => {
            cleanup();
            reject(error);
          },
        };
        const abort = () => waiter.reject(abortError(signal?.reason));
        this.waiters.add(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    try {
      this.assertSharedAdmission(name);
    } catch (error) {
      return Promise.reject(error);
    }
    const controller = new AbortController();
    const unlink = this.linkSignal(signal, controller);
    this.controllers.add(controller);

    const task = (async () => {
      if (controller.signal.aborted) {
        throw abortError(controller.signal.reason);
      }
      return fn(controller.signal);
    })();
    this.activeTasks.add(task);
    this.sharedTasks.add(task);
    this.taskNames.set(task, name);
    const cleanup = () => {
      unlink();
      this.controllers.delete(controller);
      this.activeTasks.delete(task);
      this.sharedTasks.delete(task);
      this.taskNames.delete(task);
    };
    void task.then(cleanup, cleanup);
    return task;
  }

  runExclusive<T>(
    name: string,
    quiesce: () => Promise<void>,
    fn: (signal: AbortSignal) => Promise<T>,
    options: { queueShared?: boolean } = {},
  ): Promise<T> {
    if (this.state.kind === "closing" || this.state.kind === "closed") {
      return Promise.reject(new OperationClosedError());
    }
    if (this.state.kind !== "open") {
      const current =
        "name" in this.state ? this.state.name : "unknown operation";
      return Promise.reject(new OperationBusyError(current));
    }
    this.state = { kind: "exclusive-pending", name };
    this.queueShared = options.queueShared ?? false;
    const controller = new AbortController();
    this.controllers.add(controller);

    const task = (async () => {
      try {
        await quiesce();
        await Promise.allSettled([...this.sharedTasks]);
        if (controller.signal.aborted) {
          throw abortError(controller.signal.reason);
        }
        if (this.state.kind === "closing" || this.state.kind === "closed") {
          throw new OperationClosedError();
        }
        this.state = { kind: "exclusive", name };
        return await fn(controller.signal);
      } finally {
        this.controllers.delete(controller);
        if (
          this.state.kind === "exclusive" ||
          this.state.kind === "exclusive-pending"
        ) {
          this.state = { kind: "open" };
        }
        this.queueShared = false;
        this.readWindow = undefined;
        for (const waiter of [...this.waiters]) waiter.resume();
      }
    })();
    this.activeTasks.add(task);
    this.taskNames.set(task, name);
    const cleanup = () => {
      this.activeTasks.delete(task);
      this.taskNames.delete(task);
    };
    void task.then(cleanup, cleanup);
    return task;
  }

  /** Only prune-only retention may reopen current-version reads after draining
   * old readers and closing their native handles. Writers remain excluded. */
  openVersionCleanupReadWindow(allowed: (name: string) => boolean): void {
    if (
      this.state.kind !== "exclusive" ||
      this.state.name !== "version-cleanup" ||
      !this.queueShared
    )
      throw new Error(
        "current-version reads require exclusive prune-only cleanup",
      );
    this.readWindow = allowed;
    for (const waiter of [...this.waiters])
      if (allowed(waiter.name)) waiter.resume();
  }

  /** Cancel existing work without closing admission for subsequent bounded reads. */
  abortAndDrain(reason: Error): Promise<void> {
    for (const controller of this.controllers) controller.abort(reason);
    return Promise.allSettled([...this.activeTasks]).then(() => {});
  }

  close(reason = new OperationClosedError()): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = { kind: "closing" };
    for (const waiter of [...this.waiters]) waiter.reject(reason);
    for (const controller of this.controllers) controller.abort(reason);
    const tasks = [...this.activeTasks];
    this.closePromise = Promise.allSettled(tasks).then(() => {
      this.state = { kind: "closed" };
    });
    return this.closePromise;
  }

  private assertSharedAdmission(name: string): void {
    if (this.state.kind === "closing" || this.state.kind === "closed") {
      throw new OperationClosedError();
    }
    if (
      this.state.kind === "exclusive" ||
      this.state.kind === "exclusive-pending"
    ) {
      if (this.state.kind === "exclusive" && this.readWindow?.(name)) return;
      throw new OperationBusyError(this.state.name);
    }
  }

  private linkSignal(
    source: AbortSignal | undefined,
    target: AbortController,
  ): () => void {
    if (!source) return () => {};
    const abort = () => target.abort(source.reason);
    if (source.aborted) abort();
    else source.addEventListener("abort", abort, { once: true });
    return () => source.removeEventListener("abort", abort);
  }
}
