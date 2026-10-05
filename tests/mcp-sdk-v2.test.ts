import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as V1Client } from "mcp-sdk-v1-fixture/client/index.js";
import { StdioClientTransport as V1StdioClientTransport } from "mcp-sdk-v1-fixture/client/stdio.js";
import { expect, it } from "vitest";
import { WatchLeases } from "../src/lib/daemon/watch-leases";

it.each(["legacy", "modern", "auto"])(
  "SDK v2 %s discovery/catalog has no background work and disconnect reaps every child",
  async (mode) => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "gmax-sdk-v2-")),
    );
    const home = path.join(dir, "home");
    const root = path.join(dir, "project");
    fs.mkdirSync(home);
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(
      path.join(home, "projects.json"),
      JSON.stringify([
        {
          root,
          name: "fixture",
          status: "indexed",
          chunkCount: 1,
          modelTier: "small",
          vectorDim: 384,
          embedMode: "cpu",
          lastIndexed: new Date().toISOString(),
        },
      ]),
    );
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ modelTier: "small", vectorDim: 384, embedMode: "cpu" }),
    );
    const events = path.join(dir, "events");
    const guard = path.join(dir, "guard.cjs");
    fs.writeFileSync(
      guard,
      `
      const fs = require("node:fs");
      const record = (event) => fs.appendFileSync(${JSON.stringify(events)}, event + ":" + process.pid + "\\n");
      record("start");
      process.on("exit", () => record("exit"));
      const deny = (event) => function () { record(event); throw new Error("Unexpected " + event); };
      require("node:child_process").spawn = deny("spawn");
      require("node:net").Server.prototype.listen = deny("listen");
      // The source loader uses a private pipe to its parent; permit only that pipe.
      const connect = require("node:net").Socket.prototype.connect;
      require("node:net").Socket.prototype.connect = function (...args) {
        const options = Array.isArray(args[0]) ? args[0][0] : args[0];
        const pipe = typeof options === "string" ? options : options?.path;
        if (typeof pipe === "string" && pipe.includes("/tsx-") && require("node:path").basename(pipe) === process.ppid + ".pipe") return connect.apply(this, args);
        return deny("connect")();
      };
      global.setInterval = deny("interval");
    `,
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--require",
        guard,
        "--import",
        path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
        path.join(process.cwd(), "src/bin.ts"),
        "mcp",
      ],
      cwd: root,
      // Autostart remains enabled: a regression must trip the guard.
      env: {
        ...process.env,
        HOME: dir,
        GMAX_HOME: home,
        GMAX_NO_AUTOSTART: "0",
        GMAX_NO_STALE_HINT: "1",
      },
      stderr: "pipe",
    });
    const client = new Client(
      { name: "gmax-v2-test", version: "1" },
      {
        versionNegotiation: {
          mode:
            mode === "modern"
              ? { pin: "2026-07-28" }
              : (mode as "auto" | "legacy"),
          probe: { timeoutMs: 15000 },
        },
      },
    );
    let lines: string[] = [];
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe(
        mode === "legacy" ? "legacy" : "modern",
      );
      const catalog = await client.listTools();
      const search = catalog.tools.find(
        (tool) => tool.name === "semantic_search",
      )!;
      expect(search.inputSchema.properties?.query).toMatchObject({
        type: "string",
        description: "Natural language query (5+ words recommended)",
      });
      expect(search.outputSchema?.required).toContain("schemaVersion");
      expect(search.annotations?.readOnlyHint).toBe(true);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        catalog.tools.map((tool) => tool.name),
      );
      for (const name of [
        "lancedb",
        "cache",
        "daemon.pid",
        "daemon.sock",
        "watch-leases.json",
      ]) {
        expect(fs.existsSync(path.join(home, name)), name).toBe(false);
      }
      const empty = await client.callTool({
        name: "semantic_search",
        arguments: { query: "" },
      });
      expect(empty.isError).toBe(true);
      expect(empty.content).toEqual([
        { type: "text", text: "Missing required parameter: query" },
      ]);
      expect(empty.structuredContent).toBeUndefined();
      const invalid = await client.callTool({
        name: "semantic_search",
        arguments: { query: 42 },
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      lines = fs.existsSync(events)
        ? fs.readFileSync(events, "utf8").trim().split("\n")
        : [];
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(
      lines.filter(
        (line) => !line.startsWith("start:") && !line.startsWith("exit:"),
      ),
    ).toEqual([]);
    const starts = lines
      .filter((line) => line.startsWith("start:"))
      .map((line) => line.slice(6))
      .sort();
    const exits = lines
      .filter((line) => line.startsWith("exit:"))
      .map((line) => line.slice(5))
      .sort();
    expect(starts).toHaveLength(mode === "legacy" ? 1 : 2);
    expect(exits).toEqual(starts);
  },
  45_000,
);

it.each(["legacy", "modern", "v1"])(
  "%s reads cancel independently, report progress and share one watch timer",
  async (era) => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "gmax-v2-leases-")),
    );
    const home = path.join(dir, "home");
    const roots = [path.join(dir, "first"), path.join(dir, "second")];
    fs.mkdirSync(home);
    for (const root of roots) {
      fs.mkdirSync(root);
      fs.mkdirSync(path.join(root, ".git"));
    }
    const config = {
      modelTier: "small",
      vectorDim: 384,
      embedMode: "cpu",
      queryLog: true,
    };
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
    fs.writeFileSync(
      path.join(home, "projects.json"),
      JSON.stringify(
        roots.map((root, i) => ({
          ...config,
          root,
          name: `project${i}`,
          status: "indexed",
          chunkCount: 1,
          lastIndexed: new Date().toISOString(),
        })),
      ),
    );
    const events = path.join(dir, "events");
    const guard = path.join(dir, "guard.cjs");
    fs.writeFileSync(
      guard,
      `
    const fs = require("node:fs");
    const record = (s) => fs.appendFileSync(${JSON.stringify(events)}, s + "\\n");
    const deny = (s) => function () { record(s); throw new Error(s); };
    require("node:net").Server.prototype.listen = deny("listen");
    require("node:child_process").spawn = deny("spawn");
    const interval = global.setInterval;
    global.setInterval = function (fn, ms, ...args) { record("interval:" + ms); return interval(fn, ms, ...args); };
  `,
    );
    const leases = new WatchLeases(null);
    const commands: Array<Record<string, any>> = [];
    const sockets = new Set<net.Socket>();
    let pendingSocket: net.Socket | undefined;
    let pendingClosed = false;
    const held = new Map<string, net.Socket>();
    const daemon = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
        if (socket === pendingSocket) pendingClosed = true;
      });
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        if (!buffer.includes("\n")) return;
        const cmd = JSON.parse(buffer.split("\n")[0]);
        commands.push(cmd);
        if (cmd.cmd === "watch") {
          leases.acquire(cmd.root, {
            holder: cmd.holder,
            pid: cmd.pid,
            ttlMs: cmd.ttlMs,
          });
          socket.end(`${JSON.stringify({ ok: true, pid: process.pid })}\n`);
        } else if (cmd.cmd === "graph.trace" && cmd.target === "Wait") {
          pendingSocket = socket;
        } else if (cmd.cmd === "graph.trace" && cmd.target.startsWith("Hold")) {
          held.set(cmd.target, socket);
        } else if (cmd.cmd === "rows.locate" || cmd.cmd === "search") {
          held.set(cmd.cmd, socket);
        } else if (cmd.cmd === "graph.trace") {
          socket.end(
            `${JSON.stringify({ ok: true, graph: { center: { symbol: "Fixture", file: path.join(cmd.projectRoot, "fixture.ts"), line: 0, role: "IMPLEMENTATION", calls: [], calledBy: [] }, callerTree: [], callees: [], importers: [] } })}\n`,
          );
        } else {
          socket.end(
            `${JSON.stringify({ ok: false, error: `unknown command: ${cmd.cmd}` })}\n`,
          );
        }
      });
    });
    await new Promise<void>((resolve) =>
      daemon.listen(path.join(home, "daemon.sock"), resolve),
    );
    const Transport =
      era === "v1" ? V1StdioClientTransport : StdioClientTransport;
    const transport = new Transport({
      command: process.execPath,
      args: [
        "--require",
        guard,
        "--import",
        path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
        path.join(process.cwd(), "src/bin.ts"),
        "mcp",
      ],
      cwd: roots[0],
      env: {
        ...process.env,
        HOME: dir,
        GMAX_HOME: home,
        GMAX_NO_AUTOSTART: "1",
        GMAX_NO_STALE_HINT: "1",
      },
      stderr: "pipe",
    });
    const client =
      era === "v1"
        ? new V1Client({ name: "v1-lease-test", version: "1" })
        : new Client(
            { name: "lease-test", version: "1" },
            {
              versionNegotiation: {
                mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" },
              },
            },
          );
    async function until(condition: () => boolean): Promise<void> {
      const deadline = Date.now() + 3000;
      while (!condition()) {
        if (Date.now() > deadline)
          throw new Error("Timed out waiting for IPC lifecycle");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      await client.connect(transport);
      await client.listTools();
      expect(commands).toEqual([]);
      for (const root of roots) {
        const result = await client.callTool({
          name: "trace_calls",
          arguments: { symbol: "Fixture", root },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          root,
          found: true,
          center: {
            location: { path: path.join(root, "fixture.ts"), line: 1 },
          },
        });
      }
      await until(() => roots.every((root) => leases.isWanted(root)));
      const pid = transport.pid!;
      const watchCalls = commands.filter((cmd) => cmd.cmd === "watch");
      expect(watchCalls.map((cmd) => cmd.root).sort()).toEqual(
        [...roots].sort(),
      );
      expect(
        watchCalls.every(
          (cmd) => cmd.pid === pid && cmd.holder === `mcp:${pid}`,
        ),
      ).toBe(true);
      expect(fs.readFileSync(events, "utf8").trim().split("\n")).toEqual([
        "interval:300000",
      ]);
      const sibling = client.callTool({
        name: "trace_calls",
        arguments: { symbol: "HoldSibling", root: roots[1] },
      });
      void sibling.catch(() => {});
      await until(() => held.has("HoldSibling"));
      for (const [name, args, key] of [
        ["trace_calls", { symbol: "HoldCancelled" }, "HoldCancelled"],
        ["extract_symbol", { symbol: "Fixture" }, "rows.locate"],
        [
          "semantic_search",
          { query: "find the synthetic fixture function" },
          "search",
        ],
      ] as const) {
        const controller = new AbortController();
        const progress: Array<{
          progress: number;
          message?: string;
          total?: number;
        }> = [];
        const params = { name, arguments: { ...args, root: roots[0] } };
        const options = {
          signal: controller.signal,
          onprogress: (p: (typeof progress)[number]) => progress.push(p),
        };
        const cancelled =
          client instanceof V1Client
            ? client.callTool(params, undefined, options)
            : client.callTool(params, options);
        void cancelled.catch(() => {});
        await until(() => held.has(key) && progress.length >= 2);
        const socket = held.get(key)!;
        let closed = false;
        socket.once("close", () => {
          closed = true;
        });
        controller.abort();
        await expect(cancelled).rejects.toThrow();
        await until(() => closed);
        expect(progress.map((p) => p.progress)).toEqual(
          progress.map((_, i) => i + 1),
        );
        expect(progress.every((p) => p.total === undefined)).toBe(true);
        expect(progress[0].message).toBe(`Starting ${name}`);
        const progressCount = progress.length;
        const next = await client.callTool({
          name: "trace_calls",
          arguments: { symbol: "Fixture", root: roots[1] },
        });
        expect(next.structuredContent).toMatchObject({
          root: roots[1],
          found: true,
        });
        expect(progress).toHaveLength(progressCount);
        expect(held.get("HoldSibling")!.destroyed).toBe(false);
        expect(fs.existsSync(path.join(home, "lancedb"))).toBe(false);
      }
      held
        .get("HoldSibling")!
        .end(
          `${JSON.stringify({ ok: true, graph: { center: null, callerTree: [], callees: [], importers: [] } })}\n`,
        );
      expect((await sibling).isError).not.toBe(true);
      const logPath = path.join(home, "logs", "queries.jsonl");
      const cancelledLogs = () =>
        fs
          .readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.error?.includes("abort"));
      await until(() => fs.existsSync(logPath) && cancelledLogs().length === 3);
      expect(cancelledLogs().map((entry) => entry.tool)).toEqual([
        "trace_calls",
        "extract_symbol",
        "semantic_search",
      ]);
      expect(cancelledLogs().every((entry) => entry.project === roots[0])).toBe(
        true,
      );
      expect(fs.readFileSync(events, "utf8").trim().split("\n")).toEqual([
        "interval:300000",
      ]);
      const pending = client.callTool({
        name: "trace_calls",
        arguments: { symbol: "Wait" },
      });
      void pending.catch(() => {});
      await until(() => pendingSocket !== undefined);
      await client.close();
      await expect(pending).rejects.toThrow();
      await until(() => pendingClosed);
      expect(leases.sweep().sort()).toEqual([...roots].sort());
      expect(roots.some((root) => leases.isWanted(root))).toBe(false);
      expect(fs.existsSync(path.join(home, "lancedb"))).toBe(false);
    } finally {
      await client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => daemon.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  45_000,
);
