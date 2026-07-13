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
  private closePromise: Promise<void> | null = null;

  get status(): CoordinatorState["kind"] {
    return this.state.kind;
  }

  get activeCount(): number {
    return this.activeTasks.size;
  }

  runShared<T>(
    _name: string,
    signal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      this.assertSharedAdmission();
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
    const cleanup = () => {
      unlink();
      this.controllers.delete(controller);
      this.activeTasks.delete(task);
      this.sharedTasks.delete(task);
    };
    void task.then(cleanup, cleanup);
    return task;
  }

  runExclusive<T>(
    name: string,
    quiesce: () => Promise<void>,
    fn: (signal: AbortSignal) => Promise<T>,
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
      }
    })();
    this.activeTasks.add(task);
    const cleanup = () => this.activeTasks.delete(task);
    void task.then(cleanup, cleanup);
    return task;
  }

  close(reason = new OperationClosedError()): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = { kind: "closing" };
    for (const controller of this.controllers) controller.abort(reason);
    const tasks = [...this.activeTasks];
    this.closePromise = Promise.allSettled(tasks).then(() => {
      this.state = { kind: "closed" };
    });
    return this.closePromise;
  }

  private assertSharedAdmission(): void {
    if (this.state.kind === "closing" || this.state.kind === "closed") {
      throw new OperationClosedError();
    }
    if (
      this.state.kind === "exclusive" ||
      this.state.kind === "exclusive-pending"
    ) {
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
