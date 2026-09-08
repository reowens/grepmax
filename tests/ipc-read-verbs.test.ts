import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Daemon } from "../src/lib/daemon/daemon";
import { handleCommand } from "../src/lib/daemon/ipc-handler";
import type { ReadVerbContext } from "../src/lib/daemon/read-verbs";
import {
  clearReadVerbs,
  getReadVerb,
  readVerbNames,
  registerReadVerbs,
} from "../src/lib/daemon/read-verbs";

class FakeSocket extends EventEmitter {
  writable = true;
  write = vi.fn(() => true);
  end = vi.fn();
}

const runSharedOperation = vi.fn(
  <T>(
    _name: string,
    signal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ) => fn(signal ?? new AbortController().signal),
);

const daemon = {
  isReady: () => true,
  operationStatus: () => "open",
  uptime: () => 1,
  listProjects: () => [],
  resourceGenerationId: () => 1,
  hasUnfinishedRebuild: () => false,
  runSharedOperation,
} as unknown as Daemon;

afterEach(() => {
  clearReadVerbs();
  runSharedOperation.mockClear();
});

describe("read verb registry", () => {
  it("registers from an object literal and from entry pairs", () => {
    const handler = vi.fn(async () => ({ ok: true }));
    registerReadVerbs({ "graph.resolve": handler });
    registerReadVerbs(new Map([["rows.symbols", handler]]));
    expect(readVerbNames()).toEqual(["graph.resolve", "rows.symbols"]);
    expect(getReadVerb("graph.resolve")).toBe(handler);
    expect(getReadVerb("nope")).toBeUndefined();
    expect(getReadVerb(42)).toBeUndefined();
  });
});

describe("ipc-handler read verb dispatch", () => {
  it("still reports unknown command for an unregistered verb", async () => {
    const response = await handleCommand(
      daemon,
      { cmd: "graph.resolve", projectRoot: "/work/api" },
      new FakeSocket() as never,
    );
    expect(response).toMatchObject({
      ok: false,
      error: "unknown command: graph.resolve",
    });
    expect(runSharedOperation).not.toHaveBeenCalled();
  });

  it("invokes a registered verb with the parsed payload and returns its result", async () => {
    const handler = vi.fn(
      async (_payload: Record<string, unknown>, _ctx: ReadVerbContext) => ({
        ok: true,
        symbols: ["a", "b"],
      }),
    );
    registerReadVerbs({ "graph.resolve": handler });

    const conn = new FakeSocket();
    const cmd = {
      cmd: "graph.resolve",
      projectRoot: "/work/api",
      target: "foo",
    };
    const response = await handleCommand(daemon, cmd, conn as never);

    expect(response).toEqual({ ok: true, symbols: ["a", "b"] });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toEqual(cmd);
    const ctx = handler.mock.calls[0][1];
    expect(ctx.daemon).toBe(daemon);
    expect(ctx.conn).toBe(conn);
    expect(ctx.signal.aborted).toBe(false);
  });

  it("runs the verb through runSharedOperation under its own name", async () => {
    registerReadVerbs({ "rows.symbols": async () => ({ ok: true }) });
    await handleCommand(
      daemon,
      { cmd: "rows.symbols" },
      new FakeSocket() as never,
    );
    expect(runSharedOperation).toHaveBeenCalledOnce();
    expect(runSharedOperation.mock.calls[0][0]).toBe("rows.symbols");
  });

  it("aborts the verb when the client disconnects", async () => {
    let seen: AbortSignal | undefined;
    registerReadVerbs({
      "graph.trace": async (_payload, ctx) => {
        seen = ctx.signal;
        conn.emit("close");
        return { ok: true };
      },
    });
    const conn = new FakeSocket();
    await handleCommand(daemon, { cmd: "graph.trace" }, conn as never);
    expect(seen?.aborted).toBe(true);
  });

  it("reports a verb throw as a normal error response", async () => {
    registerReadVerbs({
      "graph.dead": async () => {
        throw new Error("nope");
      },
    });
    const response = await handleCommand(
      daemon,
      { cmd: "graph.dead" },
      new FakeSocket() as never,
    );
    expect(response).toMatchObject({ ok: false, error: "nope" });
  });

  it("advertises readVerbs in ping capabilities", async () => {
    const response = await handleCommand(
      daemon,
      { cmd: "ping" },
      new FakeSocket() as never,
    );
    expect(response).toMatchObject({
      ok: true,
      capabilities: { readVerbs: 1 },
    });
  });
});
