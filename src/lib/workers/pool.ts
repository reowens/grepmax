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
};

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
  private queue: PendingTask[] = [];
  private nextId = 1;
  private destroyed = false;

  constructor() {
    const { filename, execArgv } = resolveProcessWorker();
    const workerCount = Math.max(1, CONFIG.WORKER_THREADS);
    for (let i = 0; i < workerCount; i++) {
      this.spawnWorker(filename, execArgv);
    }
  }

  private spawnWorker(filename: string, execArgv: string[]) {
    const worker = new ProcessWorker(filename, execArgv);
    const onMessage = (msg: { id: number; result?: any; error?: string }) => {
      const task = this.queue.find((t) => t.id === msg.id) || null;
      if (!task) return;
      if (msg.error) {
        task.reject(new Error(msg.error));
      } else {
        task.resolve(msg.result);
      }
      worker.busy = false;
      worker.pendingTaskId = null;
      this.queue = this.queue.filter((t) => t.id !== msg.id);
      this.dispatch();
    };

    worker.child.on("message", onMessage);
    worker.child.on("exit", (code, signal) => {
      worker.busy = false;
      const failedTasks = this.queue.filter((t) => t.worker === worker);
      for (const task of failedTasks) {
        task.reject(
          new Error(
            `Worker exited unexpectedly${code ? ` (code ${code})` : ""}${signal ? ` signal ${signal}` : ""
            }`,
          ),
        );
      }
      this.queue = this.queue.filter((t) => t.worker !== worker);
      if (!this.destroyed) {
        const { filename, execArgv } = resolveProcessWorker();
        this.spawnWorker(filename, execArgv);
      }
    });
    this.workers.push(worker);
  }

  private enqueue(method: TaskMethod, payload: any): Promise<any> {
    if (this.destroyed) {
      return Promise.reject(new Error("Worker pool destroyed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const task: PendingTask = { id, method, payload, resolve, reject };
      this.queue.push(task);
      this.dispatch();
    });
  }

  private dispatch() {
    if (this.destroyed) return;
    const idle = this.workers.find((w) => !w.busy);
    const task = this.queue.find((t) => t.worker === undefined);
    if (!idle || !task) return;

    idle.busy = true;
    idle.pendingTaskId = task.id;
    task.worker = idle;
    try {
      idle.child.send({ id: task.id, method: task.method, payload: task.payload });
    } catch (err) {
      task.reject(err);
      idle.busy = false;
      idle.pendingTaskId = null;
      task.worker = undefined;
      return;
    }
    // Allow next dispatch for remaining tasks
    this.dispatch();
  }

  processFile(input: { path: string; content: string; hash?: string }) {
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
    if (this.destroyed) return;
    this.destroyed = true;
    const killPromises = this.workers.map(
      (w) =>
        new Promise<void>((resolve) => {
          w.child.removeAllListeners("message");
          w.child.removeAllListeners("exit");
          w.child.once("exit", () => resolve());
          w.child.kill();
          setTimeout(() => resolve(), WORKER_TIMEOUT_MS);
        }),
    );
    await Promise.allSettled(killPromises);
    this.workers = [];
    this.queue.forEach((t) => t.reject(new Error("Worker pool destroyed")));
    this.queue = [];
  }
}

export const workerPool = new WorkerPool();
