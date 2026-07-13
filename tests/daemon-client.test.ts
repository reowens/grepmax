import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Must compute inside factory — vi.mock is hoisted above variable declarations
const tmpSocket = path.join(os.tmpdir(), `gmax-test-daemon.sock`);
const spawnDaemonMock = vi.hoisted(() => vi.fn(() => 12345));
vi.mock("../src/config", async () => {
  const p = await import("node:path");
  const o = await import("node:os");
  return {
    PATHS: { daemonSocket: p.join(o.tmpdir(), "gmax-test-daemon.sock") },
  };
});
vi.mock("../src/lib/utils/daemon-launcher", () => ({
  spawnDaemon: spawnDaemonMock,
}));

import {
  ensureDaemonRunning,
  isDaemonRunning,
  type StreamingProgress,
  sendDaemonCommand,
  sendStreamingCommand,
  waitForProcessExit,
} from "../src/lib/utils/daemon-client";

function startMockServer(
  handler: (data: string, socket: net.Socket) => void,
): net.Server {
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        handler(buf.slice(0, nl), socket);
        buf = buf.slice(nl + 1);
      }
    });
  });
  server.listen(tmpSocket);
  return server;
}

afterEach(() => {
  spawnDaemonMock.mockClear();
  try {
    fs.unlinkSync(tmpSocket);
  } catch {}
});

describe("daemon-client", () => {
  describe("sendDaemonCommand", () => {
    it("sends command and receives response", async () => {
      const server = startMockServer((data, socket) => {
        const cmd = JSON.parse(data);
        socket.write(`${JSON.stringify({ ok: true, cmd: cmd.cmd })}\n`);
      });

      try {
        const resp = await sendDaemonCommand({ cmd: "ping" });
        expect(resp).toEqual({ ok: true, cmd: "ping" });
      } finally {
        server.close();
      }
    });

    it("returns error on ENOENT (no socket file)", async () => {
      // tmpSocket doesn't exist (no server started)
      const resp = await sendDaemonCommand({ cmd: "ping" });
      expect(resp.ok).toBe(false);
      expect(resp.error).toBe("ENOENT");
    });

    it("returns error on timeout", async () => {
      // Server accepts but never responds
      const server = startMockServer(() => {});

      try {
        const resp = await sendDaemonCommand(
          { cmd: "ping" },
          { timeoutMs: 200 },
        );
        expect(resp.ok).toBe(false);
        expect(resp.error).toBe("timeout");
      } finally {
        server.close();
      }
    });

    it("returns error on invalid JSON response", async () => {
      const server = startMockServer((_data, socket) => {
        socket.write("not json\n");
      });

      try {
        const resp = await sendDaemonCommand({ cmd: "ping" });
        expect(resp.ok).toBe(false);
        expect(resp.error).toBe("invalid response");
      } finally {
        server.close();
      }
    });

    it("cancels an in-flight command with an AbortSignal", async () => {
      const server = startMockServer(() => {});
      const ac = new AbortController();
      try {
        const pending = sendDaemonCommand(
          { cmd: "search" },
          { timeoutMs: 1000, signal: ac.signal },
        );
        ac.abort();
        await expect(pending).resolves.toMatchObject({
          ok: false,
          error: "aborted",
        });
      } finally {
        server.close();
      }
    });
  });

  describe("sendStreamingCommand", () => {
    it("heartbeat lines reset the watchdog and are not surfaced as progress", async () => {
      // Watchdog is 100ms. Server emits a heartbeat at 70ms (resets deadline
      // to 170ms) then `done` at 130ms. Without heartbeat handling, the
      // watchdog would fire at 100ms before `done` arrives.
      const server = startMockServer((_data, socket) => {
        setTimeout(() => {
          socket.write(
            `${JSON.stringify({ type: "heartbeat", ts: Date.now() })}\n`,
          );
        }, 70);
        setTimeout(() => {
          socket.write(`${JSON.stringify({ type: "done", ok: true })}\n`);
        }, 130);
      });

      const progressMessages: StreamingProgress[] = [];
      try {
        const resp = await sendStreamingCommand(
          { cmd: "index" },
          (msg) => progressMessages.push(msg),
          { timeoutMs: 100 },
        );
        expect(resp.ok).toBe(true);
        // heartbeats must not bubble through onProgress
        expect(progressMessages).toEqual([]);
      } finally {
        server.close();
      }
    });

    it("times out without heartbeats or progress", async () => {
      // Server accepts but emits nothing. Should hit the watchdog.
      const server = startMockServer(() => {});
      try {
        await expect(
          sendStreamingCommand({ cmd: "index" }, () => {}, { timeoutMs: 100 }),
        ).rejects.toThrow("streaming command timed out");
      } finally {
        server.close();
      }
    });

    it("surfaces non-streaming daemon errors directly", async () => {
      const server = startMockServer((_data, socket) => {
        socket.write(
          `${JSON.stringify({ ok: false, error: "daemon initializing" })}\n`,
        );
      });
      try {
        await expect(
          sendStreamingCommand({ cmd: "index" }, () => {}, { timeoutMs: 100 }),
        ).rejects.toThrow("daemon initializing");
      } finally {
        server.close();
      }
    });

    it("cancels an in-flight streaming command", async () => {
      const server = startMockServer(() => {});
      const ac = new AbortController();
      try {
        const pending = sendStreamingCommand({ cmd: "index" }, () => {}, {
          timeoutMs: 1000,
          signal: ac.signal,
        });
        ac.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        server.close();
      }
    });
  });

  describe("isDaemonRunning", () => {
    it("returns true when daemon responds ok", async () => {
      const server = startMockServer((_data, socket) => {
        socket.write(`${JSON.stringify({ ok: true, pid: 12345 })}\n`);
      });

      try {
        expect(await isDaemonRunning()).toBe(true);
      } finally {
        server.close();
      }
    });

    it("returns false when no daemon", async () => {
      expect(await isDaemonRunning()).toBe(false);
    });
  });

  describe("ensureDaemonRunning", () => {
    it("waits for an existing daemon to become ready without spawning", async () => {
      let pings = 0;
      const server = startMockServer((_data, socket) => {
        pings++;
        socket.write(
          `${JSON.stringify({ ok: true, ready: pings >= 2, pid: 12345 })}\n`,
        );
      });

      try {
        await expect(ensureDaemonRunning()).resolves.toBe(true);
        expect(pings).toBeGreaterThanOrEqual(2);
        expect(spawnDaemonMock).not.toHaveBeenCalled();
      } finally {
        server.close();
      }
    });
  });
});

describe("waitForProcessExit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves true once the process is gone (ESRCH)", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(await waitForProcessExit(123456, 1000)).toBe(true);
  });

  it("resolves false on timeout while the process stays alive", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await waitForProcessExit(process.pid, 250)).toBe(false);
  });
});
