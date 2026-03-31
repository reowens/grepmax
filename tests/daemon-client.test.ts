import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Must compute inside factory — vi.mock is hoisted above variable declarations
const tmpSocket = path.join(os.tmpdir(), `gmax-test-daemon.sock`);
vi.mock("../src/config", async () => {
  const p = await import("node:path");
  const o = await import("node:os");
  return {
    PATHS: { daemonSocket: p.join(o.tmpdir(), "gmax-test-daemon.sock") },
  };
});

import { isDaemonRunning, sendDaemonCommand } from "../src/lib/utils/daemon-client";

function startMockServer(handler: (data: string, socket: net.Socket) => void): net.Server {
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
  try { fs.unlinkSync(tmpSocket); } catch {}
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
        const resp = await sendDaemonCommand({ cmd: "ping" }, { timeoutMs: 200 });
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
});
