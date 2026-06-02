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

type WorkerMessage = (
  | { id: number; result: TaskResults[TaskMethod] }
  | { id: number; error: string }
  | { id: number; heartbeat: true }
) & { rss?: number };

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
  // Absolute deadline timer, armed at dispatch and never reset by heartbeats.
  hardTimeout?: NodeJS.Timeout;
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

// Absolute per-task ceiling. Unlike TASK_TIMEOUT_MS (a no-progress timeout that
// every heartbeat resets), this is wall-clock from dispatch and is NEVER reset
// by heartbeats. It bounds a task that keeps emitting progress but never
// finishes — e.g. a worker wedged on a hung MLX request that still services its
// heartbeat timer. A single processFile (one file → batches of 16 chunks) is
// seconds even for huge files, so 5 min is generous headroom, never a real cap.
const HARD_DEADLINE_MS = (() => {
  const fromEnv = Number.parseInt(
    process.env.GMAX_WORKER_HARD_DEADLINE_MS ?? "",
    10,
  );
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 300_000;
})();

// Backstop for the leak that motivated all of the above: a worker left
// busy=true with no live timer to rescue it (a dropped IPC result, or a
// timeout-kill whose SIGKILL threw and left the process alive but de-listed).
// The reaper skips busy workers, so without this such a worker is immortal —
// we saw six survive 4-5 days. Set above HARD_DEADLINE so the per-task timer
// normally wins and this only fires for the no-timer case.
const STUCK_BUSY_MS = HARD_DEADLINE_MS + 60_000;

const FORCE_KILL_GRACE_MS = 200;
// Longer grace for idle reaps: the worker isn't urgently in the way, and a
// graceful SIGTERM lets ONNX free ~1GB of model memory. But if SIGTERM is
// ignored (a worker burning 100% CPU inside a native ONNX matmul tight loop
// won't service signals — the 42h zombie we saw in v0.17.0 validation),
// escalate to SIGKILL. ~5s is well above ONNX teardown time but short
// enough that the reap loop self-heals within a minute.
const REAP_FORCE_KILL_GRACE_MS = 5_000;

class ProcessWorker {
  child: childProcess.ChildProcess;
  busy = false;
  pendingTaskId: number | null = null;
  lastBusyTime = Date.now();
  // Wall-clock at which this worker became busy with its current task; null
  // when idle. Used by the reaper to detect workers wedged in busy=true.
  busySince: number | null = null;
  // Most recent RSS (bytes) the worker reported, for memory-based recycling.
  lastRssBytes = 0;
  // Set when the pool has cleaned up after this worker (via exit or error
  // event). Guards against handleWorkerExit running twice when both events
  // fire for the same crash.
  cleanedUp = false;

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
// Idle-worker floor. Kept at 1 (not 2) to favour low resident memory over
// search warmth: an idle worker holds ~300 MB-1 GB, and on this deployment
// searches are infrequent, so paying a one-off cold start (~10-15s to boot +
// load models) on the rare search is preferable to keeping a second worker
// warm. The pool still scales up to maxWorkers on demand for indexing bursts.
const MIN_KEEP_WORKERS = 1;

// Recycle an idle worker whose RSS has grown past this. ONNX native memory
// (model arenas) lives outside V8, so --max-old-space-size can't bound it — a
// worker that processed one big file can stay pinned at ~2 GB. Replacing it
// with a fresh worker reclaims that. 0 (or negative) disables the check.
const WORKER_RSS_RECYCLE_MB = (() => {
  const fromEnv = Number.parseInt(process.env.GMAX_WORKER_RSS_RECYCLE_MB ?? "", 10);
  if (Number.isFinite(fromEnv)) return fromEnv;
  return 800;
})();

// Methods that must skip the indexing backlog. encodeQuery is the search hot
// path: a single query is ~17ms but waits behind every queued processFile.
// rerank is similarly small and latency-sensitive.
const PRIORITY_METHODS: ReadonlySet<TaskMethod> = new Set(["encodeQuery", "rerank"]);

export class WorkerPool {
  private workers: ProcessWorker[] = [];
  // Two queues so searches don't wait behind a long indexing backlog. Priority
  // tasks (encodeQuery/rerank) are dispatched first; processFile tasks queue
  // in the regular queue. FIFO is preserved within each priority class.
  private priorityQueue: number[] = [];
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

    // Periodically reap idle workers back to MIN_KEEP, and force-kill any
    // worker wedged in busy=true (the leak backstop — see STUCK_BUSY_MS).
    this.idleReapInterval = setInterval(() => {
      this.reapStuckWorkers();
      this.reapBloatedWorkers();
      this.reapIdleWorkers();
    }, IDLE_WORKER_TIMEOUT_MS);
  }

  isHealthy(): boolean {
    return !this.destroyed && this.workers.length > 0;
  }

  /** PIDs of workers the pool currently tracks. Used by the daemon's orphan
   * sweep to distinguish live, accounted-for workers from de-listed strays. */
  getWorkerPids(): number[] {
    return this.workers
      .map((w) => w.child.pid)
      .filter((pid): pid is number => pid !== undefined);
  }

  private clearTaskTimeout<M extends TaskMethod>(task: PendingTask<M>) {
    if (task.timeout) {
      clearTimeout(task.timeout);
      task.timeout = undefined;
    }
    if (task.hardTimeout) {
      clearTimeout(task.hardTimeout);
      task.hardTimeout = undefined;
    }
  }

  private removeFromQueue(taskId: number) {
    const pi = this.priorityQueue.indexOf(taskId);
    if (pi !== -1) this.priorityQueue.splice(pi, 1);
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
      worker.busySince = null;
      worker.lastBusyTime = Date.now();
    }
  }

  private handleWorkerExit(
    worker: ProcessWorker,
    code: number | null,
    signal: NodeJS.Signals | null,
    reason: "exit" | "error" = "exit",
    err?: Error,
  ) {
    // Crash paths can fire both 'error' and 'exit'. Either is sufficient
    // to clean up; running this twice would double-respawn.
    if (worker.cleanedUp) return;
    worker.cleanedUp = true;

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
      debug("pool", `${reason} killed task=${task.id} method=${task.method} file=${filePath}`);
      const exitDetail = err
        ? `: ${err.message}`
        : `${code ? ` (code ${code})` : ""}${signal ? ` signal ${signal}` : ""}`;
      task.reject(
        new Error(`Worker ${reason === "error" ? "errored" : "exited unexpectedly"}${exitDetail}`),
      );
      this.completeTask(task, null);
    }

    log("pool", `Worker PID:${worker.child.pid} ${reason} (code:${code} signal:${signal}${err ? ` err:${err.message}` : ""} pending=${failedTasks.length})`);
    this.workers = this.workers.filter((w) => w !== worker);
    if (!this.destroyed) {
      // Only respawn if we have no workers left or there are pending tasks
      const hasUnassigned = (queue: number[]) =>
        queue.some((id) => {
          const t = this.tasks.get(id);
          return t && !t.worker;
        });
      const hasPendingTasks =
        hasUnassigned(this.priorityQueue) || hasUnassigned(this.taskQueue);
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
      if (typeof msg.rss === "number") worker.lastRssBytes = msg.rss;
      // Fast cleanup for tasks that were aborted while running
      if (this.abortedTasks.has(msg.id)) {
        this.abortedTasks.delete(msg.id);
        const task = this.tasks.get(msg.id);
        if (task) {
          this.completeTask(task, worker);
          this.recycleIfBloated(worker);
          this.dispatch();
        }
        return;
      }

      const task = this.tasks.get(msg.id);
      if (!task) return;

      if ("heartbeat" in msg) {
        // Reset only the no-progress timeout. The hard deadline is left
        // untouched on purpose — heartbeats must not be able to extend a task
        // past its absolute ceiling.
        if (task.timeout) {
          clearTimeout(task.timeout);
          task.timeout = undefined;
        }
        if (task.worker) {
          task.timeout = setTimeout(
            () => this.handleTaskTimeout(task, task.worker!, "no progress"),
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
      this.recycleIfBloated(worker);
      this.dispatch();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      this.handleWorkerExit(worker, code, signal, "exit");

    // 'error' fires when spawn fails, IPC send fails async, or the child
    // can't be killed. Without this handler the worker stays in
    // this.workers as a zombie that the next dispatch tries to send to.
    const onError = (err: Error) =>
      this.handleWorkerExit(worker, null, null, "error", err);

    worker.child.on("message", onMessage);
    worker.child.on("exit", onExit);
    worker.child.on("error", onError);
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
            // If task is still queued (in either queue), remove it
            const pi = this.priorityQueue.indexOf(id);
            if (pi !== -1) this.priorityQueue.splice(pi, 1);
            const idx = this.taskQueue.indexOf(id);
            if (pi !== -1 || idx !== -1) {
              if (idx !== -1) this.taskQueue.splice(idx, 1);
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
      if (PRIORITY_METHODS.has(method)) {
        this.priorityQueue.push(id);
      } else {
        this.taskQueue.push(id);
      }
      this.dispatch();
    });
  }

  private handleTaskTimeout<M extends TaskMethod>(
    task: PendingTask<M>,
    worker: ProcessWorker,
    reason: "no progress" | "hard deadline" = "no progress",
  ) {
    if (this.destroyed || !this.tasks.has(task.id)) return;

    this.clearTaskTimeout(task);
    const limitMs = reason === "hard deadline" ? HARD_DEADLINE_MS : TASK_TIMEOUT_MS;
    const filePath =
      (task.payload as Record<string, unknown>)?.path ??
      (task.payload as Record<string, unknown>)?.absolutePath ??
      "unknown";
    log("pool", `timeout task=${task.id} method=${task.method} file=${filePath} (${reason}, ${limitMs}ms) — killing worker PID:${worker.child.pid}`);
    this.completeTask(task, null);
    task.reject(
      new Error(
        `Worker task ${task.method} exceeded ${reason} limit (${limitMs}ms) on ${filePath}`,
      ),
    );

    worker.cleanedUp = true;
    worker.child.removeAllListeners("message");
    worker.child.removeAllListeners("exit");
    worker.child.removeAllListeners("error");
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
    // Drain priority queue first so search tasks never wait behind an
    // indexing batch.
    const findUnassigned = (queue: number[]): number | undefined =>
      queue.find((id) => {
        const t = this.tasks.get(id);
        return t && !t.worker;
      });
    const nextTaskId =
      findUnassigned(this.priorityQueue) ?? findUnassigned(this.taskQueue);

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
    idle.busySince = Date.now();
    task.worker = idle;
    task.startTime = Date.now();

    task.timeout = setTimeout(
      () => this.handleTaskTimeout(task, idle, "no progress"),
      TASK_TIMEOUT_MS,
    );
    // Absolute deadline: never cleared/re-armed by heartbeats, so a task that
    // keeps emitting progress but never completes is still bounded.
    task.hardTimeout = setTimeout(
      () => this.handleTaskTimeout(task, idle, "hard deadline"),
      HARD_DEADLINE_MS,
    );

    const filePath =
      (task.payload as Record<string, unknown>)?.path ??
      (task.payload as Record<string, unknown>)?.absolutePath ??
      "";
    const busyCount = this.workers.filter((w) => w.busy).length;
    debug("pool", `dispatch task=${task.id} method=${task.method}${filePath ? ` file=${filePath}` : ""} → PID:${idle.child.pid} (busy=${busyCount}/${this.workers.length} queue=${this.taskQueue.length}+${this.priorityQueue.length}p)`);

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
   * Force-kill workers wedged in busy=true past STUCK_BUSY_MS. The per-task
   * hard deadline normally rescues these first; this catches the case where no
   * live timer exists — a dropped IPC result, or a prior SIGKILL that threw and
   * left the process alive but de-listed. Unlike the idle reaper this ignores
   * MIN_KEEP (a stuck worker is dead weight even at the floor) and goes straight
   * to SIGKILL, letting the natural 'exit' handler fail the task and respawn.
   */
  private reapStuckWorkers() {
    if (this.destroyed) return;
    const now = Date.now();
    const stuck = this.workers.filter(
      (w) => w.busy && w.busySince !== null && now - w.busySince > STUCK_BUSY_MS,
    );
    for (const w of stuck) {
      const busyMs = w.busySince !== null ? now - w.busySince : 0;
      log(
        "pool",
        `stuck worker PID:${w.child.pid} busy ${Math.round(busyMs / 1000)}s (>${STUCK_BUSY_MS}ms) — SIGKILL`,
      );
      // Leave listeners attached so handleWorkerExit runs on the resulting
      // 'exit' event: it fails any task still bound to this worker and respawns
      // if work is pending. Do not pre-set cleanedUp for the same reason.
      try {
        w.child.kill("SIGKILL");
      } catch {}
    }
  }

  /**
   * Recycle idle workers whose RSS has grown past WORKER_RSS_RECYCLE_MB. Unlike
   * the idle reaper this ignores MIN_KEEP — a bloated worker is replaced rather
   * than merely trimmed: we SIGTERM it (graceful, lets ONNX free its arenas)
   * and respawn a fresh one if that drops us below MIN_KEEP. Only idle workers
   * are touched, so an in-flight task is never interrupted.
   */
  private reapBloatedWorkers() {
    if (this.destroyed || WORKER_RSS_RECYCLE_MB <= 0) return;
    const limitBytes = WORKER_RSS_RECYCLE_MB * 1024 * 1024;
    const bloated = this.workers.filter(
      (w) => !w.busy && w.lastRssBytes > limitBytes,
    );
    for (const w of bloated) this.recycleWorker(w, "idle");
  }

  /**
   * Recycle a worker whose RSS exceeds the threshold the instant it goes free
   * between tasks. The idle reaper alone can't catch this: under continuous
   * churn (a busy monorepo trickling one small file at a time) a worker is
   * dispatched again within the 60s idle window, so a worker that peaked at
   * ~1.4 GB on one large file never looks "idle" and stays pinned. Checking at
   * task completion — when busy was just cleared and before the next dispatch —
   * bounds RSS regardless of how steady the churn is. No-op while busy, so an
   * in-flight task is never interrupted.
   */
  private recycleIfBloated(worker: ProcessWorker) {
    if (
      this.destroyed ||
      WORKER_RSS_RECYCLE_MB <= 0 ||
      worker.busy ||
      worker.cleanedUp
    ) {
      return;
    }
    if (worker.lastRssBytes > WORKER_RSS_RECYCLE_MB * 1024 * 1024) {
      this.recycleWorker(worker, "post-task");
    }
  }

  /**
   * SIGTERM a worker (graceful, lets ONNX free its arenas), drop it from the
   * pool, escalate to SIGKILL if it ignores the signal, and refill back to the
   * floor with a fresh, lean worker. Shared by the idle and post-task RSS paths.
   */
  private recycleWorker(w: ProcessWorker, reason: string) {
    if (w.cleanedUp) return;
    log(
      "pool",
      `recycle bloated worker PID:${w.child.pid} (${reason}, rss ${Math.round(w.lastRssBytes / 1048576)}MB > ${WORKER_RSS_RECYCLE_MB}MB)`,
    );
    w.cleanedUp = true;
    w.child.removeAllListeners("message");
    w.child.removeAllListeners("exit");
    w.child.removeAllListeners("error");
    const pid = w.child.pid;
    try { w.child.kill("SIGTERM"); } catch {}
    this.workers = this.workers.filter((x) => x !== w);
    // Escalate to SIGKILL if SIGTERM is ignored (a worker mid native-call
    // won't service signals).
    if (pid !== undefined) {
      setTimeout(() => {
        try {
          process.kill(pid, 0);
          try { process.kill(pid, "SIGKILL"); } catch {}
        } catch {
          // ESRCH — already gone.
        }
      }, REAP_FORCE_KILL_GRACE_MS);
    }
    // Replace anything we dropped below the floor with fresh, lean workers.
    while (!this.destroyed && this.workers.length < MIN_KEEP_WORKERS) {
      this.spawnWorker();
    }
  }

  /**
   * Reap idle workers back down to MIN_KEEP_WORKERS. Keeps the most recently
   * active. Called on a timer — never removes busy workers. See
   * MIN_KEEP_WORKERS for the memory-vs-warmth tradeoff behind the floor.
   */
  private reapIdleWorkers() {
    const MIN_KEEP = MIN_KEEP_WORKERS;
    if (this.destroyed || this.workers.length <= MIN_KEEP) return;
    const now = Date.now();
    const toReap = this.workers.filter(
      (w) => !w.busy && now - w.lastBusyTime > IDLE_WORKER_TIMEOUT_MS,
    );
    const keepCount = Math.max(MIN_KEEP, this.workers.length - toReap.length);
    const reapCount = this.workers.length - keepCount;
    if (reapCount <= 0) return;

    // Reap oldest-idle first
    toReap
      .sort((a, b) => a.lastBusyTime - b.lastBusyTime)
      .slice(0, reapCount)
      .forEach((w) => {
        log("pool", `reap idle worker PID:${w.child.pid} (idle ${Math.round((now - w.lastBusyTime) / 1000)}s, ${this.workers.length - 1} remaining)`);
        w.cleanedUp = true;
        w.child.removeAllListeners("message");
        w.child.removeAllListeners("exit");
        w.child.removeAllListeners("error");
        const pid = w.child.pid;
        try { w.child.kill("SIGTERM"); } catch {}
        this.workers = this.workers.filter((x) => x !== w);
        // SIGTERM is ignored by a worker stuck inside a native ONNX matmul
        // tight loop. Escalate to SIGKILL if the process is still alive after
        // the grace period. Rare; warn-level so it's visible if it fires.
        if (pid !== undefined) {
          setTimeout(() => {
            try {
              process.kill(pid, 0);
              log("pool", `reap escalation: SIGTERM ignored by PID:${pid}, sending SIGKILL`);
              try { process.kill(pid, "SIGKILL"); } catch {}
            } catch {
              // ESRCH — process already gone, nothing to do.
            }
          }, REAP_FORCE_KILL_GRACE_MS);
        }
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
    this.priorityQueue = [];

    const killPromises = this.workers.map(
      (w) =>
        new Promise<void>((resolve) => {
          w.cleanedUp = true;
          w.child.removeAllListeners("message");
          w.child.removeAllListeners("exit");
          w.child.removeAllListeners("error");
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
