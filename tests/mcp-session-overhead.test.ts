import { type ChildProcess, fork } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

it("three daemon-backed MCP sessions stay lazy and preserve reads, leases and cancellation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-mcp-lazy-"));
  const home = path.join(dir, ".gmax");
  const root = path.join(dir, "project");
  const children: ChildProcess[] = [];
  const sockets = new Set<net.Socket>();
  const commands: Record<string, any>[] = [];
  let held: net.Socket | undefined;
  let heldClosed = false;
  let started!: () => void;
  const holdStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      if (socket === held) heldClosed = true;
    });
    let pending = "";
    socket.on("data", (chunk) => {
      pending += String(chunk);
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      const command = JSON.parse(pending.slice(0, newline));
      commands.push(command);
      if (command.query === "hold query") {
        held = socket;
        started();
        return;
      }
      socket.end(
        `${JSON.stringify(
          command.cmd === "watch"
            ? { ok: true, pid: process.pid }
            : { ok: true, data: [] },
        )}\n`,
      );
    });
  });

  try {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(home, "projects.json"),
      JSON.stringify([
        {
          root,
          name: "project",
          status: "indexed",
          chunkCount: 1,
          modelTier: "small",
          lastIndexed: new Date().toISOString(),
          vectorDim: 384,
          embedMode: "cpu",
        },
      ]),
    );
    const probe = path.join(dir, "probe.cjs");
    fs.writeFileSync(
      probe,
      `const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...args) {
  if (/lancedb|lmdb|web-tree-sitter/.test(request) ||
      /(?:store\\/(?:vector-db|meta-cache)|search\\/searcher|index\\/syncer|workers\\/pool)$/.test(request)) {
    throw new Error("Eager MCP dependency: " + request);
  }
  return load.call(this, request, ...args);
};
process.on("message", () => process.send({ memory: process.memoryUsage(), modules: Object.keys(require.cache) }));`,
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path.join(home, "daemon.sock"), resolve);
    });

    const sessions = children;
    for (let i = 0; i < 3; i++) {
      sessions.push(
        fork(path.join(process.cwd(), "src/bin.ts"), ["mcp"], {
          cwd: root,
          execArgv: [
            "--require",
            probe,
            "--import",
            path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
          ],
          env: {
            ...process.env,
            HOME: dir,
            GMAX_HOME: home,
            GMAX_NO_AUTOSTART: "1",
            GMAX_NO_STALE_HINT: "1",
          },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        }),
      );
    }
    const clients = sessions.map((child) => {
      let buffer = "";
      let stderr = "";
      let nextId = 1;
      const messages: any[] = [];
      const pending = new Map<number, (message: any) => void>();
      child.stdout!.on("data", (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          messages.push(message);
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      });
      child.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const send = (message: unknown) =>
        child.stdin!.write(`${JSON.stringify(message)}\n`);
      const request = (method: string, params: unknown) => {
        const id = nextId++;
        let cancel!: () => void;
        const promise = new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`MCP timeout (${method}): ${stderr}`));
          }, 10_000);
          cancel = () => {
            clearTimeout(timer);
            pending.delete(id);
            reject(new Error("Client cancelled"));
          };
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          send({ jsonrpc: "2.0", id, method, params });
        });
        return { id, promise, cancel };
      };
      return { child, request, send, messages };
    });

    await Promise.all(
      clients.map(async (client) => {
        const initialized = await client.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "lazy-session-fixture", version: "0" },
        }).promise;
        expect(initialized.error).toBeUndefined();
        client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        const catalog = await client.request("tools/list", {}).promise;
        expect(
          catalog.result.tools.some((t: any) => t.name === "semantic_search"),
        ).toBe(true);
      }),
    );
    expect(commands).toEqual([]);

    await Promise.all(
      clients.map(async (client) => {
        const search = await client.request("tools/call", {
          name: "semantic_search",
          arguments: { query: "where is the fixture handler" },
          _meta: { progressToken: 0 },
        }).promise;
        expect(search.error).toBeUndefined();
        expect(search.result.isError, JSON.stringify(search.result)).not.toBe(
          true,
        );
        expect(
          client.messages.some((m) => m.method === "notifications/progress"),
        ).toBe(true);
      }),
    );
    const summary = await clients[0].request("tools/call", {
      name: "summarize_directory",
      arguments: {},
    }).promise;
    expect(summary.result.isError).not.toBe(true);
    expect(summary.result.content[0].text).toContain("No chunks to summarize");

    const leases = commands.filter((command) => command.cmd === "watch");
    expect(leases).toHaveLength(3);
    expect(new Set(leases.map((lease) => lease.holder)).size).toBe(3);
    for (const lease of leases) {
      expect(lease.root).toBe(root);
      expect(lease.holder).toBe(`mcp:${lease.pid}`);
      expect(lease.ttlMs).toBe(15 * 60 * 1000);
    }

    const cancellation = clients[0].request("tools/call", {
      name: "semantic_search",
      arguments: { query: "hold query" },
    });
    await holdStarted;
    clients[0].send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: cancellation.id, reason: "fixture cancellation" },
    });
    cancellation.cancel();
    await expect(cancellation.promise).rejects.toThrow("Client cancelled");
    // The independent peer can still read after another session cancels.
    expect(
      (
        await clients[1].request("tools/call", {
          name: "semantic_search",
          arguments: { query: "where is the fixture handler" },
        }).promise
      ).result.isError,
    ).not.toBe(true);
    const closeDeadline = Date.now() + 2000;
    while (!heldClosed && Date.now() < closeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(heldClosed).toBe(true);
    expect(fs.existsSync(path.join(home, "lancedb.lease/readers"))).toBe(false);
    for (const child of children) {
      const state = await new Promise<any>((resolve) => {
        child.once("message", resolve);
        child.send("state");
      });
      expect(
        state.modules.some((file: string) =>
          /lancedb|lmdb|web-tree-sitter/.test(file),
        ),
      ).toBe(false);
      expect(state.memory.heapUsed).toBeGreaterThan(0);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    for (const child of children) {
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
