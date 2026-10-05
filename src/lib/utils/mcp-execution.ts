import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerContext } from "@modelcontextprotocol/server";

interface Execution {
  request: ServerContext["mcpReq"];
  stages: number;
  notifications: Promise<void>;
}

const executions = new AsyncLocalStorage<Execution>();

/** Session background work must not retain the triggering request's signal. */
export function withoutMcpExecution<T>(work: () => T): T {
  return executions.exit(work);
}

export function mcpSignal(): AbortSignal | undefined {
  return executions.getStore()?.request.signal;
}

/** Check between operations, never race a native query against store close. */
export function checkMcpCancellation(): void {
  mcpSignal()?.throwIfAborted();
}

/** Counts started operation stages, not completion percentages. No timers. */
export async function mcpOperation<T>(
  message: string,
  work: () => Promise<T>,
): Promise<T> {
  checkMcpCancellation();
  const execution = executions.getStore();
  const progressToken = execution?.request._meta?.progressToken;
  if (execution && progressToken !== undefined) {
    const progress = ++execution.stages;
    execution.notifications = execution.notifications.then(async () => {
      if (execution.request.signal.aborted) return;
      try {
        await execution.request.notify({
          method: "notifications/progress",
          params: { progressToken, progress, message },
        });
      } catch {
        // Progress is advisory; a peer declining it must not break a read.
      }
    });
    await execution.notifications;
  }
  checkMcpCancellation();
  const result = await work();
  checkMcpCancellation();
  return result;
}

export function withMcpExecution<T>(
  request: ServerContext["mcpReq"] | undefined,
  work: () => Promise<T>,
): Promise<T> {
  // Non-protocol callers (including the catalog's unit fixtures) have no context.
  if (!request) return work();
  return executions.run(
    { request, stages: 0, notifications: Promise.resolve() },
    work,
  );
}
