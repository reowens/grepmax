import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_LEASE_TTL_MS, WatchLeases } from "../src/lib/daemon/watch-leases";

describe("WatchLeases", () => {
  let now: number;
  let alive: Set<number>;
  const make = (file: string | null = null) =>
    new WatchLeases(file, {
      now: () => now,
      isPidAlive: (pid) => alive.has(pid),
    });

  beforeEach(() => {
    now = 1_000_000;
    alive = new Set([100, 200]);
  });

  it("reports a root as newly wanted only on its first lease", () => {
    const leases = make();
    expect(
      leases.acquire("/a", { holder: "mcp:100", pid: 100, ttlMs: 60_000 }),
    ).toBe(true);
    expect(
      leases.acquire("/a", { holder: "mcp:200", pid: 200, ttlMs: 60_000 }),
    ).toBe(false);
    expect(
      leases.acquire("/a", { holder: "mcp:100", pid: 100, ttlMs: 60_000 }),
    ).toBe(false);
    expect(leases.wantedRoots()).toEqual(new Set(["/a"]));
  });

  it("keeps a root while any holder lives and drops it when the last goes", () => {
    const leases = make();
    leases.acquire("/a", { holder: "mcp:100", pid: 100, ttlMs: 60_000 });
    leases.acquire("/a", { holder: "mcp:200", pid: 200, ttlMs: 60_000 });

    alive.delete(100);
    expect(leases.sweep()).toEqual([]);
    expect(leases.isWanted("/a")).toBe(true);

    alive.delete(200);
    expect(leases.isWanted("/a")).toBe(false);
    expect(leases.sweep()).toEqual(["/a"]);
    expect(leases.sweep()).toEqual([]);
  });

  it("expires TTL leases and renewal extends them", () => {
    const leases = make();
    leases.acquire("/a", { holder: "cli", ttlMs: 60_000 });
    now += 50_000;
    leases.acquire("/a", { holder: "cli", ttlMs: 60_000 });
    now += 50_000;
    expect(leases.isWanted("/a")).toBe(true);
    now += 20_000;
    expect(leases.sweep()).toEqual(["/a"]);
  });

  it("caps requested TTLs", () => {
    const leases = make();
    leases.acquire("/a", { holder: "cli", ttlMs: MAX_LEASE_TTL_MS * 10 });
    now += MAX_LEASE_TTL_MS + 1;
    expect(leases.isWanted("/a")).toBe(false);
  });

  it("releases one holder, or every holder when none is named", () => {
    const leases = make();
    leases.acquire("/a", { holder: "session:x", ttlMs: 60_000 });
    leases.acquire("/a", { holder: "mcp:100", pid: 100, ttlMs: 60_000 });
    leases.acquire("/b", { holder: "session:x", ttlMs: 60_000 });

    leases.release("/a", "session:x");
    expect(leases.isWanted("/a")).toBe(true);
    expect(leases.isWanted("/b")).toBe(true);

    leases.release("/a");
    expect(leases.isWanted("/a")).toBe(false);
    expect(leases.isWanted("/b")).toBe(true);
  });

  describe("persistence", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-leases-"));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("restores live leases and skips dead or expired ones", () => {
      const file = path.join(dir, "watch-leases.json");
      const first = make(file);
      first.acquire("/live", { holder: "mcp:100", pid: 100, ttlMs: 60_000 });
      first.acquire("/dead", { holder: "mcp:300", pid: 300, ttlMs: 60_000 });
      first.acquire("/short", { holder: "cli", ttlMs: 1_000 });

      now += 5_000;
      const second = make(file);
      second.load();
      expect(second.wantedRoots()).toEqual(new Set(["/live"]));
    });

    it("ignores a corrupt file", () => {
      const file = path.join(dir, "watch-leases.json");
      fs.writeFileSync(file, "{not json");
      const leases = make(file);
      leases.load();
      expect(leases.wantedRoots().size).toBe(0);
    });
  });
});

describe("session hook renewal throttling", () => {
  const hour = 60 * 60 * 1000;
  const source = fs.readFileSync(
    path.resolve("plugins/grepmax/hooks/watch-lease.js"),
    "utf8",
  );
  type Command = {
    cmd: string;
    root?: string;
    holder?: string;
    ttlMs?: number;
  };
  type Reply = {
    ok: boolean;
    error?: string;
    capabilities?: { watchLeases: number };
  };
  type Api = {
    ensureSessionLease: (
      input: { session_id: string },
      cwd: string,
      options?: { allowStart?: boolean; throttle?: boolean },
    ) => Promise<boolean>;
    releaseSessionLeases: (
      input: { session_id: string },
      cwd: string,
    ) => Promise<boolean>;
  };
  let home: string;
  let now: number;
  let commands: Command[];
  let env: Record<string, string>;
  let response: (command: Command) => Reply | string;
  let spawns: number;
  let leases: WatchLeases;
  const input = { session_id: "one" };
  const project = "/project";

  function load() {
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module,
      Date: { now: () => now },
      setTimeout,
      clearTimeout,
      process: { env, pid: process.pid, kill: process.kill.bind(process) },
      require(name: string) {
        switch (name) {
          case "node:crypto":
            return crypto;
          case "node:fs":
            return fs;
          case "node:path":
            return path;
          case "node:os":
            return { homedir: () => home };
          case "node:child_process":
            return {
              spawn: () => {
                spawns++;
                throw Error("fixture forbids daemon startup");
              },
            };
          case "node:net":
            return {
              connect: () => {
                const socket = Object.assign(new EventEmitter(), {
                  destroy() {},
                  write(line: string) {
                    const command: Command = JSON.parse(line);
                    commands.push(command);
                    const reply = response(command);
                    if (typeof reply === "string") {
                      queueMicrotask(() =>
                        socket.emit("error", { code: reply }),
                      );
                    } else {
                      if (reply.ok && command.cmd === "watch") {
                        leases.acquire(command.root!, {
                          holder: command.holder!,
                          ttlMs: command.ttlMs!,
                        });
                      }
                      if (reply.ok && command.cmd === "unwatch")
                        leases.release(command.root!, command.holder);
                      queueMicrotask(() =>
                        socket.emit("data", `${JSON.stringify(reply)}\n`),
                      );
                    }
                  },
                });
                queueMicrotask(() => socket.emit("connect"));
                return socket;
              },
            };
          default:
            throw Error(`unexpected require ${name}`);
        }
      },
    });
    return module.exports as Api;
  }

  const renew = (holder = input, cwd = project) =>
    load().ensureSessionLease(holder, cwd, {
      allowStart: true,
      throttle: true,
    });
  const cacheDir = () => path.join(home, ".gmax/hook-watch-leases");
  const stateFile = () =>
    path.join(
      cacheDir(),
      fs.readdirSync(cacheDir()).find((file) => file.endsWith(".json"))!,
    );

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-hook-renewal-"));
    fs.mkdirSync(path.join(home, ".gmax"));
    fs.writeFileSync(path.join(home, ".gmax/daemon.sock"), "first daemon");
    fs.writeFileSync(
      path.join(home, ".gmax/projects.json"),
      JSON.stringify([{ root: project }, { root: "/other" }]),
    );
    now = 1_000_000;
    commands = [];
    env = {};
    spawns = 0;
    response = () => ({ ok: true, capabilities: { watchLeases: 1 } });
    leases = new WatchLeases(null, { now: () => now });
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("persists startup acquisition and skips repeated activity across hook processes", async () => {
    expect(await load().ensureSessionLease(input, project)).toBe(true);
    for (let i = 0; i < 10; i++) expect(await renew()).toBe(true);
    expect(commands.map((cmd) => cmd.cmd)).toEqual(["ping", "watch"]);
    expect(commands[1]).toEqual({
      cmd: "watch",
      root: project,
      holder: "session:one",
      ttlMs: 4 * hour,
    });
    now += hour - 1;
    expect(await renew()).toBe(true);
    expect(commands).toHaveLength(2);
    now++;
    expect(await renew()).toBe(true);
    expect(commands.map((cmd) => cmd.cmd)).toEqual([
      "ping",
      "watch",
      "ping",
      "watch",
    ]);
    expect(JSON.parse(fs.readFileSync(stateFile(), "utf8")).renewedAt).toBe(
      now,
    );
  });

  it("keeps an active session leased beyond the original TTL", async () => {
    for (let i = 0; i < 6; i++) {
      expect(await renew()).toBe(true);
      now += hour;
      expect(leases.isWanted(project)).toBe(true);
    }
    now += 4 * hour;
    expect(leases.isWanted(project)).toBe(false);
  });

  it("scopes renewal state by holder and registered root", async () => {
    await renew();
    await renew(input, "/project/src");
    await renew({ session_id: "two" });
    await renew(input, "/other");
    expect(
      commands
        .filter((cmd) => cmd.cmd === "watch")
        .map((cmd) => [cmd.root, cmd.holder]),
    ).toEqual([
      [project, "session:one"],
      [project, "session:two"],
      ["/other", "session:one"],
    ]);
  });

  it("coalesces concurrent activity hooks", async () => {
    expect(await Promise.all([renew(), renew(), renew()])).toEqual([
      true,
      true,
      true,
    ]);
    expect(commands.map((cmd) => cmd.cmd)).toEqual(["ping", "watch"]);
  });

  it("invalidates cached success when the daemon socket is replaced", async () => {
    await renew();
    const socket = path.join(home, ".gmax/daemon.sock");
    fs.renameSync(socket, `${socket}.old`);
    fs.writeFileSync(socket, "new daemon");
    leases.release(project);
    expect(await renew()).toBe(true);
    expect(commands).toHaveLength(4);
    expect(leases.isWanted(project)).toBe(true);
  });

  it("retries a failed watch without caching it", async () => {
    response = (cmd) =>
      cmd.cmd === "watch"
        ? { ok: false, error: "DAEMON_BUSY" }
        : { ok: true, capabilities: { watchLeases: 1 } };
    expect(await renew()).toBe(false);
    expect(fs.readdirSync(cacheDir())).toEqual([]);
    response = () => ({ ok: true, capabilities: { watchLeases: 1 } });
    expect(await renew()).toBe(true);
    expect(commands).toHaveLength(4);
  });

  it.each(["corrupt", "future"])("ignores %s renewal state", async (kind) => {
    await renew();
    const file = stateFile();
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(
      file,
      kind === "corrupt"
        ? "{broken"
        : JSON.stringify({
            ...state,
            renewedAt: now + hour,
          }),
    );
    expect(await renew()).toBe(true);
    expect(commands).toHaveLength(4);
  });

  it("releases after an in-flight renewal and reacquires on later activity", async () => {
    const acquiring = renew();
    const releasing = load().releaseSessionLeases(input, project);
    expect(await acquiring).toBe(true);
    expect(await releasing).toBe(true);
    expect(leases.isWanted(project)).toBe(false);
    expect(fs.readdirSync(cacheDir())).toEqual([]);
    expect(await renew()).toBe(true);
    expect(leases.isWanted(project)).toBe(true);
    expect(commands.map((cmd) => cmd.cmd)).toEqual([
      "ping",
      "watch",
      "ping",
      "unwatch",
      "ping",
      "watch",
    ]);
  });

  it("reclaims a lock left by a dead hook", async () => {
    await renew();
    const file = stateFile();
    fs.unlinkSync(file);
    const lock = file.replace(/\.json$/, ".lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "2147483647"), "");
    expect(await renew()).toBe(true);
    expect(commands).toHaveLength(4);
  });

  it("does not release through a daemon without lease support", async () => {
    await renew();
    response = () => ({ ok: true });
    expect(await load().releaseSessionLeases(input, project)).toBe(false);
    expect(commands.map((cmd) => cmd.cmd)).toEqual(["ping", "watch", "ping"]);
    expect(fs.readdirSync(cacheDir())).toEqual([]);
  });

  it("renews conservatively when cache storage is unavailable", async () => {
    fs.writeFileSync(cacheDir(), "not a directory");
    expect(await renew()).toBe(true);
    expect(commands).toHaveLength(2);
  });

  it.each(["env", "gemma", "file", "safety"])(
    "honors %s autostart-off before cached success",
    async (kind) => {
      await renew();
      if (kind === "env") env.GMAX_NO_AUTOSTART = "1";
      else if (kind === "gemma") env.GMAX_GEMMA_PROFILE = "1";
      else
        fs.writeFileSync(
          path.join(
            home,
            ".gmax",
            kind === "file" ? "autostart-disabled" : "safety-stop.json",
          ),
          "",
        );
      expect(await renew()).toBe(false);
      expect(commands).toHaveLength(2);
      expect(spawns).toBe(0);
    },
  );

  it.each(["EPERM", "EACCES", "ECONNRESET"])(
    "does not spawn beside a %s socket",
    async (error) => {
      response = () => error;
      expect(await renew()).toBe(false);
      expect(spawns).toBe(0);
    },
  );

  it.each(["ENOENT", "ECONNREFUSED"])(
    "retains absent-socket autostart policy for %s",
    async (error) => {
      response = () => error;
      expect(await renew()).toBe(false);
      expect(spawns).toBe(1);
    },
  );

  it("makes the activity entry point request throttled renewal", async () => {
    let call: unknown[] | undefined;
    const activity = fs.readFileSync(
      path.resolve("plugins/grepmax/hooks/activity.js"),
      "utf8",
    );
    await vm.runInNewContext(activity, {
      require: () => ({
        readHookInput: async () => ({ ...input, cwd: project }),
        ensureSessionLease: (...args: unknown[]) => {
          call = args;
        },
      }),
    });
    expect(call).toEqual([
      { ...input, cwd: project },
      project,
      { allowStart: true, throttle: true },
    ]);
  });
});
