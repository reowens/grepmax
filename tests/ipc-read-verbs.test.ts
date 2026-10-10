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
  it("preserves measured query time on a handler failure", async () => {
    let clock = 100;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    registerReadVerbs({
      "rows.locate": async (_payload, ctx) => {
        clock += 17;
        Object.assign(ctx.locateTimings!, { tableMs: 2, queryMs: 15 });
        throw new Error("query execution timed out");
      },
    });
    try {
      const response = await handleCommand(
        daemon,
        { cmd: "rows.locate", diagnostics: true },
        new FakeSocket() as never,
      );
      expect(response).toMatchObject({
        ok: false,
        error: "query execution timed out",
        readTimings: {
          tableMs: 2,
          queryMs: 15,
          normalizeMs: 0,
          admissionWaitMs: 0,
          handlerMs: 17,
          totalMs: 17,
        },
      });
    } finally {
      now.mockRestore();
    }
  });

  it("retains admission failure timing without reporting negative or handler durations", async () => {
    let clock = 100;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    registerReadVerbs({
      "rows.locate": async () => ({ ok: true, rows: [[]] }),
    });
    const refusing = {
      ...daemon,
      runSharedOperation: async () => {
        clock += 25;
        throw new Error("admission refused");
      },
    } as unknown as Daemon;
    try {
      const response = await handleCommand(
        refusing,
        { cmd: "rows.locate", diagnostics: true },
        new FakeSocket() as never,
      );
      expect(response).toMatchObject({
        ok: false,
        error: "admission refused",
        readTimings: {
          schemaVersion: 1,
          gateWaitMs: 0,
          admissionWaitMs: 25,
          handlerMs: 0,
          totalMs: 25,
        },
      });
    } finally {
      now.mockRestore();
    }
  });

  it("separates admission and handler time only when locate diagnostics are explicitly enabled", async () => {
    let clock = 100;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    registerReadVerbs({
      "rows.locate": async () => {
        clock += 30;
        return {
          ok: true,
          rows: [[]],
          readTimings: { tableMs: 10, queryMs: 20, normalizeMs: 0 },
        };
      },
    });
    const waiting = {
      ...daemon,
      runSharedOperation: async (
        _name: string,
        signal: AbortSignal,
        fn: (signal: AbortSignal) => Promise<unknown>,
      ) => {
        clock += 20;
        return fn(signal);
      },
    } as unknown as Daemon;
    try {
      const response = await handleCommand(
        waiting,
        { cmd: "rows.locate", diagnostics: true },
        new FakeSocket() as never,
      );
      expect(response?.readTimings).toEqual({
        schemaVersion: 1,
        tableMs: 10,
        queryMs: 20,
        normalizeMs: 0,
        gateWaitMs: 0,
        admissionWaitMs: 20,
        handlerMs: 30,
        totalMs: 50,
      });
      registerReadVerbs({
        "rows.locate": async () => ({ ok: true, rows: [[]] }),
      });
      for (const diagnostics of [undefined, false, "true", 1]) {
        const plain = await handleCommand(
          waiting,
          { cmd: "rows.locate", diagnostics },
          new FakeSocket() as never,
        );
        expect(plain).toEqual({ ok: true, rows: [[]] });
      }
    } finally {
      now.mockRestore();
    }
  });

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

  it("validates paused limits after an active request waited for admission", async () => {
    let paused = false;
    const handler = vi.fn(async () => ({ ok: true }));
    registerReadVerbs({ "rows.locate": handler });
    const transitioning = {
      ...daemon,
      serviceStatus: () => ({ mode: paused ? "paused" : "active" }),
      runSharedOperation: async (
        _name: string,
        signal: AbortSignal,
        fn: (signal: AbortSignal) => Promise<unknown>,
      ) => {
        paused = true;
        return fn(signal);
      },
    } as unknown as Daemon;
    const response = await handleCommand(
      transitioning,
      {
        cmd: "rows.locate",
        limit: 5000,
        matches: [{ kind: "definedSymbol", symbol: "start" }],
      },
      new FakeSocket() as never,
    );
    expect(response).toMatchObject({ ok: false, code: "DAEMON_PAUSED" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses large paused responses without triggering MCP oversize fallback", async () => {
    registerReadVerbs({
      "rows.skeleton": async () => ({ ok: true, skeleton: "x".repeat(300000) }),
    });
    const paused = {
      ...daemon,
      serviceStatus: () => ({ mode: "paused" }),
    } as unknown as Daemon;
    const response = await handleCommand(
      paused,
      { cmd: "rows.skeleton", path: "/fixture/file.ts" },
      new FakeSocket() as never,
    );
    expect(response).toMatchObject({ ok: false, code: "DAEMON_PAUSED" });
    expect(response?.error).not.toContain("oversize");
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
