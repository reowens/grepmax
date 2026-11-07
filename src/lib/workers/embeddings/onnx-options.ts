import type * as ort from "onnxruntime-node";

/** Intra-op threads for each CPU ONNX session, set by the pool for its workers. */
export const ONNX_THREADS_ENV = "GMAX_ONNX_THREADS";
const MAX_ONNX_THREADS = 4;

/**
 * Threads per session so that every admitted background file running at once
 * asks for at most 1.5x the effective CPUs: 4 CPUs with 3 files gives 2, and a
 * lone file then uses 2 CPUs instead of 1. More oversubscription than that lost
 * 25-40% of aggregate throughput under a 400% quota.
 */
export function onnxThreadsFor(
  effectiveCpus: number,
  backgroundFiles: number,
): number {
  const cpus = Math.max(1, Math.floor(effectiveCpus));
  const files = Math.max(1, Math.floor(backgroundFiles));
  return Math.max(
    1,
    Math.min(MAX_ONNX_THREADS, cpus, Math.floor((3 * cpus) / (2 * files))),
  );
}

export function onnxThreads(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env[ONNX_THREADS_ENV] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_ONNX_THREADS, parsed)
    : 1;
}

/**
 * Inference runs 1 chunk per call: the activations of a padded batch of 16
 * outgrow the core's cache and cost 20-25% more per chunk than 1 at a time.
 * Spinning is off because idle spinning threads burn the service's CPU quota;
 * with spinning on, 4 threads ran slower than 1.
 */
export function cpuSessionOptions(
  env: NodeJS.ProcessEnv = process.env,
): ort.InferenceSession.SessionOptions {
  return {
    executionProviders: ["cpu"],
    intraOpNumThreads: onnxThreads(env),
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
    // Variable-length inputs mean the arena and memory-pattern optimizer are
    // never reused across runs; they only retain the largest tensor seen (a
    // long or minified file once pinned about 2 GB for a worker's lifetime).
    enableCpuMemArena: false,
    enableMemPattern: false,
    extra: { session: { intra_op: { allow_spinning: "0" } } },
  };
}
