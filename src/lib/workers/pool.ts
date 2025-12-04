import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG, WORKER_TIMEOUT_MS } from "../../config";

type TaskMethod = "processFile" | "encodeQuery" | "rerank";

type PendingTask = {
  id: number;
  method: TaskMethod;
  payload: any;
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  worker?: ProcessWorker;
  timeout?: NodeJS.Timeout;
};

const TASK_TIMEOUT_MS = (() => {
  const fromEnv = Number.parseInt(process.env.OSGREP_WORKER_TASK_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 30_000;
})();

const FORCE_KILL_GRACE_MS = 200;

class ProcessWorker {
  child: childProcess.ChildProcess;
  busy = false;
  pendingTaskId: number | null = null;

  constructor(public modulePath: string, public execArgv: string[]) {
    this.child = childProcess.fork(modulePath, {
      execArgv,
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

export class WorkerPool {
  private workers: ProcessWorker[] = [];
  private taskQueue: number[] = [];
  private tasks = new Map<number, PendingTask>();
  private nextId = 1;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  private readonly modulePath: string;
  private readonly execArgv: string[];

  constructor() {
    const resolved = resolveProcessWorker();
    this.modulePath = resolved.filename;
    this.execArgv = resolved.execArgv;

    const workerCount = Math.max(1, CONFIG.WORKER_THREADS);
    for (let i = 0; i < workerCount; i++) {
      this.spawnWorker();
    }
  }

  private clearTaskTimeout(task: PendingTask) {
    if (task.timeout) {
      clearTimeout(task.timeout);
      task.timeout = undefined;
    }
  }

  private removeFromQueue(taskId: number) {
    const idx = this.taskQueue.indexOf(taskId);
    if (idx !== -1) this.taskQueue.splice(idx, 1);
  }

  private completeTask(task: PendingTask, worker: ProcessWorker | null) {
    this.clearTaskTimeout(task);
    this.tasks.delete(task.id);
    this.removeFromQueue(task.id);

    if (worker) {
      worker.busy = false;
      worker.pendingTaskId = null;
    }
  }

  private handleWorkerExit(worker: ProcessWorker, code: number | null, signal: NodeJS.Signals | null) {
    worker.busy = false;
    const failedTasks = Array.from(this.tasks.values()).filter((t) => t.worker === worker);
    for (const task of failedTasks) {
      this.clearTaskTimeout(task);
      task.reject(
        new Error(
          `Worker exited unexpectedly${code ? ` (code ${code})` : ""}${signal ? ` signal ${signal}` : ""
          }`,
        ),
      );
      this.completeTask(task, null);
    }

    this.workers = this.workers.filter((w) => w !== worker);
    if (!this.destroyed) {
      this.spawnWorker();
    }
  }

  private spawnWorker() {
    const worker = new ProcessWorker(this.modulePath, this.execArgv);

    const onMessage = (msg: { id: number; result?: any; error?: string }) => {
      const task = this.tasks.get(msg.id);
      if (!task) return;

      if (msg.error) {
        task.reject(new Error(msg.error));
      } else {
        task.resolve(msg.result);
      }

      this.completeTask(task, worker);
      this.dispatch();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      this.handleWorkerExit(worker, code, signal);

    worker.child.on("message", onMessage);
    worker.child.on("exit", onExit);
    this.workers.push(worker);
  }

  private enqueue(method: TaskMethod, payload: any): Promise<any> {
    if (this.destroyed) {
      return Promise.reject(new Error("Worker pool destroyed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const task: PendingTask = { id, method, payload, resolve, reject };
      this.tasks.set(id, task);
      this.taskQueue.push(id);
      this.dispatch();
    });
  }

  private handleTaskTimeout(task: PendingTask, worker: ProcessWorker) {
    if (this.destroyed || !this.tasks.has(task.id)) return;

    this.clearTaskTimeout(task);
    console.warn(
      `[worker-pool] ${task.method} timed out after ${TASK_TIMEOUT_MS}ms; restarting worker.`,
    );
    task.reject(new Error(`Worker task ${task.method} timed out after ${TASK_TIMEOUT_MS}ms`));

    worker.child.removeAllListeners("message");
    worker.child.removeAllListeners("exit");
    try {
      worker.child.kill("SIGKILL");
    } catch { }

    this.workers = this.workers.filter((w) => w !== worker);
    if (!this.destroyed) {
      this.spawnWorker();
    }

    this.completeTask(task, null);
    this.dispatch();
  }

  private dispatch() {
    if (this.destroyed) return;
    const idle = this.workers.find((w) => !w.busy);
    const nextTaskId = this.taskQueue.find((id) => {
      const t = this.tasks.get(id);
      return t && !t.worker;
    });

    if (!idle || nextTaskId === undefined) return;
    const task = this.tasks.get(nextTaskId);
    if (!task) {
      this.removeFromQueue(nextTaskId);
      this.dispatch();
      return;
    }

    idle.busy = true;
    idle.pendingTaskId = task.id;
    task.worker = idle;

    task.timeout = setTimeout(() => this.handleTaskTimeout(task, idle), TASK_TIMEOUT_MS);

    try {
      idle.child.send({ id: task.id, method: task.method, payload: task.payload });
    } catch (err) {
      this.clearTaskTimeout(task);
      this.completeTask(task, idle);
      task.reject(err);
      return;
    }

    this.dispatch();
  }

  processFile(input: { path: string; absolutePath?: string }) {
    return this.enqueue("processFile", input);
  }

  encodeQuery(text: string) {
    return this.enqueue("encodeQuery", { text });
  }

  rerank(input: {
    query: number[][];
    docs: Array<{ colbert: Buffer | Int8Array | number[]; scale: number }>;
    colbertDim: number;
  }) {
    return this.enqueue("rerank", input);
  }

  async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    if (this.destroyed) return;

    this.destroyed = true;

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
            } catch { }
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
