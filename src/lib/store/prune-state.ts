import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PruneResult } from "./lance-cleanup";

export interface PruneState {
  schemaVersion: 1;
  storeIdentity: string;
  attemptId: string;
  version: number;
  cutoffMs: number;
  startedAt: number;
  finishedAt?: number;
  outcome: "running" | "uncertain" | "completed";
  previousUncertainAttemptId?: string;
  result?: PruneResult;
}

export function pruneStatePath(storeDir: string): string {
  return path.join(storeDir, ".gmax-prune-state.json");
}

/** A running receipt survives parent death. Readers must treat it as uncertain,
 * never as successful cleanup or permission to launch automatic maintenance. */
export function readPruneState(storeDir: string): PruneState | null {
  const identity = fs.realpathSync(storeDir);
  const target = pruneStatePath(identity);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > 16 * 1024)
    throw new Error("Prune state is unverified or oversized");
  const state = JSON.parse(fs.readFileSync(target, "utf8")) as PruneState;
  if (
    state.schemaVersion !== 1 ||
    state.storeIdentity !== identity ||
    typeof state.attemptId !== "string" ||
    !state.attemptId ||
    !Number.isSafeInteger(state.version) ||
    state.version < 1 ||
    !Number.isSafeInteger(state.cutoffMs) ||
    !Number.isSafeInteger(state.startedAt) ||
    !["running", "uncertain", "completed"].includes(state.outcome) ||
    (state.outcome === "completed" &&
      (!Number.isSafeInteger(state.finishedAt) ||
        state.result?.version !== state.version ||
        state.result?.engine !== "12.0.0" ||
        state.result?.rewritten !== false))
  )
    throw new Error("Prune state is invalid; cleanup remains pending");
  return state.outcome === "running"
    ? { ...state, outcome: "uncertain" }
    : state;
}

/** Persist and sync before native deletion. Failure refuses the operation;
 * failed final writes leave a running/uncertain receipt for the next reader. */
export function writePruneState(state: PruneState): void {
  const target = pruneStatePath(state.storeIdentity);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size > 16 * 1024)
      throw new Error("Prune state is unverified or oversized");
  }
  const temporary = path.join(
    state.storeIdentity,
    `.gmax-prune-${randomUUID()}.tmp`,
  );
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(state)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
    const directory = fs.openSync(state.storeIdentity, "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
