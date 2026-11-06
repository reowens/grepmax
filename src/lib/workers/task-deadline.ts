// Absolute per-task ceiling. Unlike TASK_TIMEOUT_MS (a no-progress timeout that
// every heartbeat resets), this is wall-clock from dispatch and is NEVER reset
// by heartbeats. It bounds a task that keeps emitting progress but never
// finishes — e.g. a worker wedged on a hung MLX request that still services its
// heartbeat timer. With MLX a processFile is seconds even for huge files, so
// 5 min is headroom. CPU inference runs about 0.2 s per chunk on one thread, so
// a 1 MB document with several hundred chunks needs minutes; a 5 min cap there
// aborts it on every attempt and the file never indexes.
export function hardDeadlineMs(embedMode: "cpu" | "gpu"): number {
  const fromEnv = Number.parseInt(
    process.env.GMAX_WORKER_HARD_DEADLINE_MS ?? "",
    10,
  );
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return embedMode === "cpu" ? 1_800_000 : 300_000;
}
