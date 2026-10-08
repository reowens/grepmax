import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { Daemon } from "../src/lib/daemon/daemon";
import { handleCommand } from "../src/lib/daemon/ipc-handler";

it.each(["documents.status", "documents.search"])(
  "restricted %s IPC preserves payload and aborts only the request",
  async (cmd) => {
    const socket = new EventEmitter(),
      controllerObserved: any[] = [];
    const documentSearch = vi.fn(async (_payload, signal) => {
      controllerObserved.push(signal);
      socket.emit("close");
      expect(signal.aborted).toBe(true);
      return { ok: false, state: "cancelled" };
    });
    const daemon = {
      isReady: () => true,
      operationStatus: () => "open",
      documentSearch,
      search: vi.fn(),
      requestWatch: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as Daemon;
    const request = { cmd, query: "PRIVATE_QUERY_CANARY", contractVersion: 1 };
    expect(await handleCommand(daemon, request, socket as any)).toEqual({
      ok: false,
      state: "cancelled",
    });
    expect(documentSearch.mock.calls[0][0]).toBe(request);
    expect(socket.listenerCount("close")).toBe(0);
    expect(daemon.search).not.toHaveBeenCalled();
    expect(daemon.requestWatch).not.toHaveBeenCalled();
    expect(daemon.shutdown).not.toHaveBeenCalled();
  },
);
it("ping advertises the enforced document protocol", async () => {
  const daemon = {
    isReady: () => true,
    operationStatus: () => "open",
    uptime: () => 1,
    resourceGenerationId: () => 1,
    hasUnfinishedRebuild: () => false,
  } as unknown as Daemon;
  expect(
    await handleCommand(daemon, { cmd: "ping" }, new EventEmitter() as any),
  ).toMatchObject({ capabilities: { existingIndexOnlySearch: 1 } });
});
