import type { ServerContext } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import {
  mcpOperation,
  mcpSignal,
  withMcpExecution,
  withoutMcpExecution,
} from "../src/lib/utils/mcp-execution";

function request(signal: AbortSignal, notify = vi.fn(async () => {})) {
  return {
    signal,
    notify,
    _meta: { progressToken: 0 },
  } as unknown as ServerContext["mcpReq"];
}

it("cancellation waits for active local work and its cleanup before rejecting", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const active = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closed = false;
  let settled = false;
  const pending = withMcpExecution(request(controller.signal), () =>
    mcpOperation("Local read", async () => {
      entered();
      try {
        await active;
        return "result";
      } finally {
        closed = true;
      }
    }),
  );
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await started;
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(closed).toBe(false);
  release();
  await expect(pending).rejects.toThrow();
  expect(closed).toBe(true);
});

it("accepts token zero, tolerates notification failure and detaches background work", async () => {
  const controller = new AbortController();
  const notify = vi.fn(async () => {
    throw new Error("Peer declined progress");
  });
  await withMcpExecution(request(controller.signal, notify), async () => {
    await mcpOperation("Read", async () => 1);
    await mcpOperation("Render", async () => 2);
    expect(mcpSignal()).toBe(controller.signal);
    expect(withoutMcpExecution(() => mcpSignal())).toBeUndefined();
    expect(mcpSignal()).toBe(controller.signal);
  });
  expect(notify.mock.calls).toEqual(
    [1, 2].map((progress) => [
      {
        method: "notifications/progress",
        params: {
          progressToken: 0,
          progress,
          message: progress === 1 ? "Read" : "Render",
        },
      },
    ]),
  );
  expect(mcpSignal()).toBeUndefined();
});
