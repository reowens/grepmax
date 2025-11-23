import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { v4 as uuidv4 } from "uuid";
import { VECTOR_CACHE_MAX, WORKER_TIMEOUT_MS } from "../config";
import { LRUCache } from "./lru";

type WorkerRequest =
  | { id: string; text: string }
  | { id: string; texts: string[] }
  | { id: string; rerank: { query: string; documents: string[] } };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  payload: WorkerRequest;
  timeoutId?: NodeJS.Timeout;
};

export class WorkerManager {
  private worker!: Worker;
  private vectorCache = new LRUCache<string, number[]>(VECTOR_CACHE_MAX);
  private pendingRequests = new Map<string, PendingRequest>();
  private restartInFlight: Promise<void> | null = null;
  private isClosing = false;
  private readonly MAX_WORKER_RSS = 6 * 1024 * 1024 * 1024; // 6GB upper bound, we restart before OOM
  private embedQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.initializeWorker();
  }

  private getWorkerConfig(): { workerPath: string; execArgv: string[] } {
    const tsWorkerPath = path.join(__dirname, "worker.ts");
    const jsWorkerPath = path.join(__dirname, "worker.js");
    const hasTsWorker = fs.existsSync(tsWorkerPath);
    const hasJsWorker = fs.existsSync(jsWorkerPath);
    const runningTs = path.extname(__filename) === ".ts";
    const isDev = (runningTs && hasTsWorker) || (hasTsWorker && !hasJsWorker);

    if (isDev) {
      return { workerPath: tsWorkerPath, execArgv: ["-r", "ts-node/register"] };
    }
    return { workerPath: jsWorkerPath, execArgv: [] };
  }

  private initializeWorker() {
    const { workerPath, execArgv } = this.getWorkerConfig();
    this.worker = new Worker(workerPath, { execArgv });

    this.worker.on("message", (message) => {
      const { id, vector, vectors, scores, error, memory } = message;
      const pending = this.pendingRequests.get(id);

      if (pending) {
        if (pending.timeoutId) clearTimeout(pending.timeoutId);

        if (error) {
          pending.reject(new Error(error));
        } else if (vectors !== undefined) {
          pending.resolve(vectors);
        } else if (scores !== undefined) {
          pending.resolve(scores);
        } else {
          pending.resolve(vector);
        }
        this.pendingRequests.delete(id);
      }

      if (memory && memory.rss > this.MAX_WORKER_RSS) {
        console.warn(
          `Worker memory usage high (${Math.round(memory.rss / 1024 / 1024)}MB). Restarting...`,
        );
        void this.restartWorker("memory limit exceeded");
      }
    });

    this.worker.on("error", (err) => {
      console.error("Worker error:", err);
      void this.restartWorker(`worker error: ${err.message}`);
    });

    this.worker.on("exit", (code) => {
      if (code !== 0 && !this.isClosing) {
        console.error(`Worker exited with code ${code}`);
        void this.restartWorker(`worker exit: code ${code}`);
      }
    });
  }

  private rejectAllPending(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async restartWorker(reason?: string) {
    if (this.restartInFlight) {
      return this.restartInFlight;
    }

    this.rejectAllPending(
      new Error(`Worker restarting: ${reason || "unknown reason"}`),
    );

    this.restartInFlight = (async () => {
      try {
        await this.worker.terminate();
      } catch (err) {
        console.error("Failed to terminate worker cleanly:", err);
      }
      this.initializeWorker();
      if (reason) {
        console.warn(`Worker restarted due to ${reason}`);
      }
    })();

    await this.restartInFlight;
    this.restartInFlight = null;
  }

  private async sendToWorker<T>(
    buildPayload: (id: string) => WorkerRequest,
  ): Promise<T> {
    if (this.restartInFlight) {
      await this.restartInFlight;
    }

    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const payload = buildPayload(id);

      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          reject(
            new Error(`Worker request timed out after ${WORKER_TIMEOUT_MS}ms`),
          );
        }
      }, WORKER_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject: reject as (reason: unknown) => void,
        payload,
        timeoutId,
      });
      this.worker.postMessage(payload);
    });
  }

  private async enqueueEmbedding<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.embedQueue.then(async () => {
      if (this.restartInFlight) {
        await this.restartInFlight;
      }
      return fn();
    }, fn);
    this.embedQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const neededIndices: number[] = [];
    const neededTexts: string[] = [];
    const results: number[][] = new Array(texts.length);

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const cached = this.vectorCache.get(text);
      if (cached !== undefined) {
        results[i] = cached;
      } else {
        neededIndices.push(i);
        neededTexts.push(text);
      }
    }

    if (neededTexts.length === 0) return results;

    const computedVectors = await this.enqueueEmbedding(() =>
      this.sendToWorker<number[][]>((id) => ({ id, texts: neededTexts })),
    );

    for (let i = 0; i < computedVectors.length; i++) {
      const originalIndex = neededIndices[i];
      const vector = computedVectors[i];
      const text = neededTexts[i];

      this.vectorCache.set(text, vector);
      results[originalIndex] = vector;
    }

    return results;
  }

  async getEmbedding(text: string): Promise<number[]> {
    const results = await this.getEmbeddings([text]);
    return results[0];
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    return this.enqueueEmbedding(() =>
      this.sendToWorker<number[]>((id) => ({
        id,
        rerank: { query, documents },
      })),
    );
  }

  async close(): Promise<void> {
    this.isClosing = true;
    try {
      this.worker.postMessage({ type: "shutdown" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await this.worker.terminate();
    } catch (err) {
      // Silent cleanup
    }
  }
}
