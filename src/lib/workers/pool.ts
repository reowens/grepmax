/**
 * Architecture Note: We use a custom Child Process pool instead of Worker Threads
 * to ensure the ONNX Runtime segfaults do not crash the main process.
 */
import * as childProcess from "node:child_process";
import { log, debug } from "../utils/logger";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG, MAX_WORKER_MEMORY_MB, WORKER_TIMEOUT_MS } from "../../config";
import type { ProcessFileInput, ProcessFileResult, RerankDoc } from "./worker";

type TaskMethod = "processFile" | "encodeQuery" | "rerank";

type EncodeQueryResult = Awaited<
  ReturnType<typeof import("./worker")["encodeQuery"]>
>;
type RerankResult = Awaited<ReturnType<typeof import("./worker")["rerank"]>>;

type TaskPayloads = {
  processFile: ProcessFileInput;
  encodeQuery: { text: string };
  rerank: { query: number[][]; docs: RerankDoc[]; colbertDim: number };
};

type TaskResults = {
  processFile: ProcessFileResult;
  encodeQuery: EncodeQueryResult;
  rerank: RerankResult;
};

type WorkerMessage =
  | { id: number; result: TaskResults[TaskMethod] }
  | { id: number; error: string }
  | { id: number; heartbeat: true };

function reviveBufferLike(input: unknown): Buffer | Int8Array | unknown {
  if (
    input &&
    typeof input === "object" &&
    "type" in (input as Record<string, unknown>) &&
    (input as Record<string, unknown>).type === "Buffer" &&
    Array.isArray((input as Record<string, unknown>).data)
  ) {
    return Buffer.from((input as Record<string, unknown>).data as number[]);
  }
  return input;
}

function reviveProcessFileResult(
  result: TaskResults["processFile"],
): TaskResults["processFile"] {
  if (!result || !Array.isArray(result.vectors)) return result;
  const vectors = result.vectors.map((v) => {
    const revived = reviveBufferLike(v.colbert);
    return revived && (Buffer.isBuffer(revived) || revived instanceof Int8Array)
      ? { ...v, colbert: revived }
      : v;
  });
  return { ...result, vectors };
}

type PendingTask<M extends TaskMethod = TaskMethod> = {
  id: number;
  method: M;
  payload: TaskPayloads[M];
  resolve: (value: TaskResults[M]) => void;
  reject: (reason?: unknown) => void;
  worker?: ProcessWorker;
  timeout?: NodeJS.Timeout;
  startTime?: number;
};

const TASK_TIMEOUT_MS = (() => {
  const fromEnv = Number.parseInt(
    process.env.GMAX_WORKER_TASK_TIMEOUT_MS ?? "",
    10,
  );
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 120_000;
})();

const FORCE_KILL_GRACE_MS = 200;

class ProcessWorker {
  child: childProcess.ChildProcess;
  busy = false;
  pendingTaskId: number | null = null;
  lastBusyTime = Date.now();

  constructor(
    public modulePath: string,
    public execArgv: string[],
    maxMemoryMb?: number,
  ) {
    const memArgs = maxMemoryMb
      ? [`--max-old-space-size=${maxMemoryMb}`]
      : [];
    this.child = childProcess.fork(modulePath, {
      execArgv: [...memArgs, ...execArgv],
      env: { ...process.env },
    });
  }
}

function resolveProcessWorker(): { filename: string; execArgv: string[] } {
  const jsWorker = path.join(__dirname, "process-child.js");
  const tsWorker = path.join(__dirname, "process-child.ts");

  if (fs.existsSync(jsWorker)) {
    return { filename: jsWorker, execArgv: [] };
  }

  if (fs.existsSync(tsWorker)) {
    return { filename: tsWorker, execArgv: ["-r", "ts-node/register"] };
  }

  throw new Error("Process worker file not found");
}

const IDLE_WORKER_TIMEOUT_MS = 60_000; // reap idle workers after 60s

export class WorkerPool {
  private workers: ProcessWorker[] = [];
  private taskQueue: number[] = [];
  private tasks = new Map<number, PendingTask<TaskMethod>>();
  private abortedTasks = new Set<number>();
  private nextId = 1;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  private readonly modulePath: string;
  private readonly execArgv: string[];
  private readonly maxWorkers: number;
  private consecutiveRespawns = 0;
  private static readonly MAX_RESPAWNS = 10;
  private idleReapInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const resolved = resolveProcessWorker();
    this.modulePath = resolved.filename;
    this.execArgv = resolved.execArgv;
    this.maxWorkers = Math.max(1, CONFIG.WORKER_THREADS);

    // Lazy spawn: start with 1 worker, scale up on demand
    this.spawnWorker();

    // Periodically reap idle workers back down to 1
    this.idleReapInterval = setInterval(() => this.reapIdleWorkers(), IDLE_WORKER_TIMEOUT_MS);
  }

  isHealthy(): boolean {
    return !this.destroyed && this.workers.length > 0;
  }

  private clearTaskTimeout<M extends TaskMethod>(task: PendingTask<M>) {
    if (task.timeout) {
      clearTimeout(task.timeout);
      task.timeout = undefined;
    }
  }

  private removeFromQueue(taskId: number) {
    const idx = this.taskQueue.indexOf(taskId);
    if (idx !== -1) this.taskQueue.splice(idx, 1);
  }

  private completeTask<M extends TaskMethod>(
    task: PendingTask<M>,
    worker: ProcessWorker | null,
  ) {
    this.clearTaskTimeout(task);
    this.tasks.delete(task.id);
    this.removeFromQueue(task.id);

    if (worker) {
      worker.busy = false;
      worker.pendingTaskId = null;
      worker.lastBusyTime = Date.now();
    }
  }

  private handleWorkerExit(
    worker: ProcessWorker,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) {
    worker.busy = false;
    const failedTasks = Array.from(this.tasks.values()).filter(
      (t) => t.worker === worker,
    );
    for (const task of failedTasks) {
      this.clearTaskTimeout(task);
      const filePath =
        (task.payload as Record<string, unknown>)?.path ??
        (task.payload as Record<string, unknown>)?.absolutePath ??
        "unknown";
      debug("pool", `exit killed task=${task.id} method=${task.method} file=${filePath}`);
      task.reject(
        new Error(
          `Worker exited unexpectedly${code ? ` (code ${code})` : ""}${
            signal ? ` signal ${signal}` : ""
          }`,
        ),
      );
      this.completeTask(task, null);
    }

    log("pool", `Worker PID:${worker.child.pid} exited (code:${code} signal:${signal} pending=${failedTasks.length})`);
    this.workers = this.workers.filter((w) => w !== worker);
    if (!this.destroyed) {
      // Only respawn if we have no workers left or there are pending tasks
      const hasPendingTasks = this.taskQueue.some((id) => {
        const t = this.tasks.get(id);
        return t && !t.worker;
      });
      if (this.workers.length === 0 || hasPendingTasks) {
        this.consecutiveRespawns++;
        log("pool", `respawn #${this.consecutiveRespawns} after exit (workers=${this.workers.length} pending=${hasPendingTasks})`);
        if (this.consecutiveRespawns > WorkerPool.MAX_RESPAWNS) {
          console.error(
            `[pool] Worker respawn limit reached (${WorkerPool.MAX_RESPAWNS}). Not spawning more workers.`,
          );
          return;
        }
        this.spawnWorker();
      }
      this.dispatch();
    }
  }

  private spawnWorker() {
    const worker = new ProcessWorker(this.modulePath, this.execArgv, MAX_WORKER_MEMORY_MB);
    log("pool", `spawn PID:${worker.child.pid} (${this.workers.length + 1}/${Math.max(1, CONFIG.WORKER_THREADS)})`);

    const onMessage = (msg: WorkerMessage) => {
      // Fast cleanup for tasks that were aborted while running
      if (this.abortedTasks.has(msg.id)) {
        this.abortedTasks.delete(msg.id);
        const task = this.tasks.get(msg.id);
        if (task) {
          this.completeTask(task, worker);
          this.dispatch();
        }
        return;
      }

      const task = this.tasks.get(msg.id);
      if (!task) return;

      if ("heartbeat" in msg) {
        // Reset timeout
        this.clearTaskTimeout(task);
        if (task.worker) {
          task.timeout = setTimeout(
            () => this.handleTaskTimeout(task, task.worker!),
            TASK_TIMEOUT_MS,
          );
        }
        return;
      }

      if ("error" in msg) {
        const filePath =
          (task.payload as Record<string, unknown>)?.path ??
          (task.payload as Record<string, unknown>)?.absolutePath ??
          "unknown";
        debug("pool", `error task=${task.id} method=${task.method} file=${filePath}: ${msg.error}`);
        task.reject(new Error(msg.error));
      } else {
        let result = msg.result as TaskResults[TaskMethod];
        if (task.method === "processFile") {
          result = reviveProcessFileResult(
            result as TaskResults["processFile"],
          ) as TaskResults[TaskMethod];
        }
        const elapsed = task.startTime ? `${Date.now() - task.startTime}ms` : "?ms";
        const filePath =
          (task.payload as Record<string, unknown>)?.path ??
          (task.payload as Record<string, unknown>)?.absolutePath ??
          "";
        debug("pool", `complete task=${task.id} method=${task.method} ${elapsed}${filePath ? ` file=${filePath}` : ""}`);
        task.resolve(result);
      }

      this.completeTask(task, worker);
      this.consecutiveRespawns = 0;
      this.dispatch();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      this.handleWorkerExit(worker, code, signal);

    worker.child.on("message", onMessage);
    worker.child.on("exit", onExit);
    this.workers.push(worker);
  }

  private enqueue<M extends TaskMethod>(
    method: M,
    payload: TaskPayloads[M],
    signal?: AbortSignal,
  ): Promise<TaskResults[M]> {
    if (this.destroyed) {
      return Promise.reject(new Error("Worker pool destroyed"));
    }
    if (signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = (val: TaskResults[M]) => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };
      const safeReject = (reason?: unknown) => {
        if (!settled) {
          settled = true;
          reject(reason);
        }
      };

      const task: PendingTask<M> = {
        id,
        method,
        payload,
        resolve: safeResolve,
        reject: safeReject,
      };

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            // If task is still in queue, remove it
            const idx = this.taskQueue.indexOf(id);
            if (idx !== -1) {
              this.taskQueue.splice(idx, 1);
              this.tasks.delete(id);
              const err = new Error("Aborted");
              err.name = "AbortError";
              safeReject(err);
            }
            // If task is already running (assigned to worker), we can't easily kill it without
            // killing the worker. For now, we just let it finish but reject the promise early so
            // the caller doesn't wait. The worker will eventually finish and we'll ignore the result.
            else if (this.tasks.has(id)) {
              // Task is running. Reject caller immediately.
              const err = new Error("Aborted");
              err.name = "AbortError";
              safeReject(err);
              // Track for fast cleanup when the worker eventually finishes.
              this.abortedTasks.add(id);
            }
          },
          { once: true },
        );
      }

      this.tasks.set(id, task as unknown as PendingTask<TaskMethod>);
      this.taskQueue.push(id);
      this.dispatch();
    });
  }

  private handleTaskTimeout<M extends TaskMethod>(
    task: PendingTask<M>,
    worker: ProcessWorker,
  ) {
    if (this.destroyed || !this.tasks.has(task.id)) return;

    this.clearTaskTimeout(task);
    const filePath =
      (task.payload as Record<string, unknown>)?.path ??
      (task.payload as Record<string, unknown>)?.absolutePath ??
      "unknown";
    log("pool", `timeout task=${task.id} method=${task.method} file=${filePath} after ${TASK_TIMEOUT_MS}ms — killing worker PID:${worker.child.pid}`);
    this.completeTask(task, null);
    task.reject(
      new Error(
        `Worker task ${task.method} timed out after ${TASK_TIMEOUT_MS}ms on ${filePath}`,
      ),
    );

    worker.child.removeAllListeners("message");
    worker.child.removeAllListeners("exit");
    try {
      worker.child.kill("SIGKILL");
    } catch {}

    this.workers = this.workers.filter((w) => w !== worker);
    if (!this.destroyed) {
      this.spawnWorker();
    }
    this.dispatch();
  }

  private dispatch() {
    if (this.destroyed) return;
    let idle = this.workers.find((w) => !w.busy);
    const nextTaskId = this.taskQueue.find((id) => {
      const t = this.tasks.get(id);
      return t && !t.worker;
    });

    if (nextTaskId === undefined) return;

    // Lazy spawn: if no idle worker and below max, spawn one
    if (!idle && this.workers.length < this.maxWorkers) {
      this.spawnWorker();
      idle = this.workers[this.workers.length - 1];
    }

    if (!idle) return;
    const task = this.tasks.get(nextTaskId);
    if (!task) {
      this.removeFromQueue(nextTaskId);
      this.dispatch();
      return;
    }

    idle.busy = true;
    idle.pendingTaskId = task.id;
    task.worker = idle;
    task.startTime = Date.now();

    task.timeout = setTimeout(
      () => this.handleTaskTimeout(task, idle),
      TASK_TIMEOUT_MS,
    );

    const filePath =
      (task.payload as Record<string, unknown>)?.path ??
      (task.payload as Record<string, unknown>)?.absolutePath ??
      "";
    const busyCount = this.workers.filter((w) => w.busy).length;
    debug("pool", `dispatch task=${task.id} method=${task.method}${filePath ? ` file=${filePath}` : ""} → PID:${idle.child.pid} (busy=${busyCount}/${this.workers.length} queue=${this.taskQueue.length})`);

    try {
      idle.child.send({
        id: task.id,
        method: task.method,
        payload: task.payload,
      });
    } catch (err) {
      debug("pool", `dispatch send failed task=${task.id}: ${err}`);
      this.clearTaskTimeout(task);
      this.completeTask(task, idle);
      task.reject(err);
      return;
    }

    this.dispatch();
  }

  processFile(input: ProcessFileInput, signal?: AbortSignal) {
    return this.enqueue("processFile", input, signal);
  }

  encodeQuery(text: string, signal?: AbortSignal) {
    return this.enqueue("encodeQuery", { text }, signal);
  }

  rerank(input: TaskPayloads["rerank"], signal?: AbortSignal) {
    return this.enqueue("rerank", input, signal);
  }

  /**
   * Reap idle workers back down to 1. Keeps the most recently active worker.
   * Called on a timer — never removes the last worker or busy workers.
   */
  private reapIdleWorkers() {
    if (this.destroyed || this.workers.length <= 1) return;
    const now = Date.now();
    const toReap = this.workers.filter(
      (w) => !w.busy && now - w.lastBusyTime > IDLE_WORKER_TIMEOUT_MS,
    );
    // Always keep at least 1 worker alive
    const keepCount = Math.max(1, this.workers.length - toReap.length);
    const reapCount = this.workers.length - keepCount;
    if (reapCount <= 0) return;

    // Reap oldest-idle first
    toReap
      .sort((a, b) => a.lastBusyTime - b.lastBusyTime)
      .slice(0, reapCount)
      .forEach((w) => {
        log("pool", `reap idle worker PID:${w.child.pid} (idle ${Math.round((now - w.lastBusyTime) / 1000)}s, ${this.workers.length - 1} remaining)`);
        w.child.removeAllListeners("message");
        w.child.removeAllListeners("exit");
        try { w.child.kill("SIGTERM"); } catch {}
        this.workers = this.workers.filter((x) => x !== w);
      });
  }

  async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    if (this.destroyed) return;

    this.destroyed = true;
    if (this.idleReapInterval) {
      clearInterval(this.idleReapInterval);
      this.idleReapInterval = null;
    }

    for (const task of this.tasks.values()) {
      this.clearTaskTimeout(task);
      task.reject(new Error("Worker pool destroyed"));
    }
    this.tasks.clear();
    this.taskQueue = [];

    const killPromises = this.workers.map(
      (w) =>
        new Promise<void>((resolve) => {
          w.child.removeAllListeners("message");
          w.child.removeAllListeners("exit");
          w.child.once("exit", () => resolve());
          w.child.kill("SIGTERM");
          const force = setTimeout(() => {
            try {
              w.child.kill("SIGKILL");
            } catch {}
          }, FORCE_KILL_GRACE_MS);
          setTimeout(() => {
            clearTimeout(force);
            resolve();
          }, WORKER_TIMEOUT_MS);
        }),
    );

    this.destroyPromise = Promise.allSettled(killPromises).then(() => {
      this.workers = [];
      this.destroyPromise = null;
    });

    await this.destroyPromise;
  }
}

let singleton: WorkerPool | null = null;

export function getWorkerPool(): WorkerPool {
  if (!singleton) {
    singleton = new WorkerPool();
  }
  return singleton;
}

export async function destroyWorkerPool(): Promise<void> {
  if (!singleton) return;
  const pool = singleton;
  singleton = null;
  await pool.destroy();
}

export function isWorkerPoolInitialized(): boolean {
  return singleton !== null;
}
