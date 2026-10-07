import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

async function request(
  socketPath: string,
  cmd: Record<string, unknown>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("fixture request timeout"));
    }, 3_000);
    const finish = (error?: Error, result?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    let buffer = "";
    socket.on("error", (error) => finish(error));
    socket.on("connect", () => socket.write(`${JSON.stringify(cmd)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n"))
        finish(undefined, JSON.parse(buffer.split("\n")[0]));
    });
  });
}

it.each(["quarantine", "warning", "unknown"])(
  "starts a model-free bounded service at %s and preserves markers",
  async (mode) => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "gmax-paused-start-")),
    );
    const home = path.join(dir, ".gmax");
    const root = path.join(dir, "project");
    fs.mkdirSync(home);
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, ".git"));
    const markers =
      mode === "quarantine"
        ? {
            "safety-stop.json":
              '{"schemaVersion":1,"at":1,"reason":"old unknown kernel probe"}\n',
            "autostart-disabled": "fixture quarantine\n",
          }
        : {};
    for (const [name, contents] of Object.entries(markers))
      fs.writeFileSync(path.join(home, name), contents);
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        modelTier: "small",
        vectorDim: 384,
        embedMode: "gpu",
        workerThreads: 1,
      }),
    );
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
          embedMode: "gpu",
          lastIndexed: new Date().toISOString(),
        },
      ]),
    );
    const guard = path.join(dir, "guard.cjs");
    fs.writeFileSync(
      guard,
      `
    const cp = require('node:child_process');
    cp.spawn = () => { throw new Error('worker/model spawn forbidden in paused fixture'); };
    const run = cp.execFileSync;
    cp.execFileSync = (cmd, args, options) => {
      if (cmd === 'sysctl' && args.includes('kern.memorystatus_vm_pressure_level')) return ${JSON.stringify(mode === "unknown" ? "unavailable\n" : "2\n")};
      if (cmd === 'zprint') return ${JSON.stringify(
        [
          "                            elem         cur         max        cur         max         cur  alloc  alloc",
          "zone name                   size        size        size      #elts       #elts       inuse   size  count",
          "-------------------------------------------------------------------------------------------------------------",
          "data.kalloc.1024            1024          0K          0K          0           0        1000     0K      0",
        ].join("\n"),
      )};
      return run(cmd, args, options);
    };
    require('node:module').syncBuiltinESMExports();
  `,
    );
    const child = spawn(
      process.execPath,
      [
        "--require",
        guard,
        "--import",
        path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
        path.join(process.cwd(), "src/bin.ts"),
        "watch",
        "--daemon",
        ...(mode === "quarantine" || process.platform !== "darwin"
          ? ["--read-only"]
          : []),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: dir,
          GMAX_HOME: home,
          GMAX_NO_AUTOSTART: "0",
          GMAX_NO_STALE_HINT: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (d) => {
      output += d;
    });
    child.stderr.on("data", (d) => {
      output += d;
    });
    const exit = once(child, "exit");
    try {
      const socket = path.join(home, "daemon.sock");
      let ping: any;
      for (let i = 0; i < 150; i++) {
        if (child.exitCode !== null) throw new Error(output);
        if (fs.existsSync(socket)) {
          ping = await request(socket, { cmd: "ping" }).catch(() => null);
          if (ping?.ready) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ping, output).toMatchObject({
        ok: true,
        ready: true,
        service: { mode: "paused" },
      });
      const status = await request(socket, { cmd: "status" });
      expect(status).toMatchObject({
        ok: true,
        workers: 0,
        projects: [],
        service: { mode: "paused" },
      });
      expect(
        (await request(socket, { cmd: "watch", root, holder: "fixture" })).ok,
      ).toBe(true);
      const write = await request(socket, { cmd: "index", root });
      expect(write).toMatchObject({ ok: false, code: "DAEMON_PAUSED" });
      expect((await request(socket, { cmd: "ping" })).ready).toBe(true);
      expect(fs.existsSync(path.join(home, "lancedb"))).toBe(false);
      expect(fs.existsSync(path.join(home, "cache", "meta.lmdb"))).toBe(false);
      for (const [name, contents] of Object.entries(markers))
        expect(fs.readFileSync(path.join(home, name), "utf8")).toBe(contents);
      if (mode !== "quarantine")
        expect(fs.existsSync(path.join(home, "safety-stop.json"))).toBe(false);
      await request(socket, { cmd: "shutdown", reason: "fixture complete" });
      await exit;
      expect(child.exitCode, output).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await exit;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
