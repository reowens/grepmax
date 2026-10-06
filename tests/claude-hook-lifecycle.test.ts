import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchLeases } from "../src/lib/daemon/watch-leases";

type Input = {
  session_id?: string;
  cwd?: string;
  old_cwd?: string;
  new_cwd?: string;
};
type Response = {
  ok?: boolean;
  error?: string;
  capabilities?: { watchLeases?: number };
};
type Reply = Response | string;
type LeaseApi = {
  ensureSessionLease: (
    input: Input,
    cwd: string,
    options?: { allowStart?: boolean },
  ) => Promise<boolean>;
  acquireSessionLease: (input: Input, cwd: string) => Promise<boolean>;
  releaseSessionLeases: (input: Input, cwd: string) => Promise<boolean>;
  registeredRootFor: (cwd: string) => string | null;
};
const hooksDir = path.resolve("plugins/grepmax/hooks");
const live: Response = { ok: true, capabilities: { watchLeases: 1 } };

function helper(
  options: {
    disabled?: "env" | "file" | "safety" | "unknown";
    replies?: Reply[];
    failSpawn?: boolean;
    watch?: (cmd: Record<string, unknown>) => void;
  } = {},
) {
  const commands: Record<string, unknown>[] = [];
  const spawns: { args: string[]; cwd: string }[] = [];
  const replies = [...(options.replies ?? [live])];
  let last: Reply = live;
  let connections = 0;
  const exports = {};
  const context = {
    module: { exports },
    process: {
      env: options.disabled === "env" ? { GMAX_NO_AUTOSTART: "1" } : {},
    },
    Date,
    setTimeout,
    clearTimeout,
    require(name: string) {
      if (name === "node:fs")
        return {
          lstatSync: (file: string) => {
            if (options.disabled === "unknown")
              throw Object.assign(Error("denied"), { code: "EACCES" });
            if (
              options.disabled === "file" &&
              file.endsWith("autostart-disabled")
            )
              return {};
            if (
              options.disabled === "safety" &&
              file.endsWith("safety-stop.json")
            )
              return {};
            throw Object.assign(Error("absent"), { code: "ENOENT" });
          },
          readFileSync: () =>
            JSON.stringify([{ root: "/project" }, { root: "/project/nested" }]),
        };
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => "/synthetic" };
      if (name === "node:child_process")
        return {
          spawn: (
            _command: string,
            args: string[],
            opts: { cwd: string; env: Record<string, string> },
          ) => {
            expect(opts.env.GMAX_DAEMON_START_ONLY).toBe("1");
            spawns.push({ args, cwd: opts.cwd });
            const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
            queueMicrotask(() =>
              child.emit(
                options.failSpawn ? "error" : "spawn",
                options.failSpawn ? Error("missing executable") : undefined,
              ),
            );
            return child;
          },
        };
      if (name === "node:net")
        return {
          connect: () => {
            connections++;
            if (replies.length) last = replies.shift()!;
            const reply = last;
            const socket = Object.assign(new EventEmitter(), {
              destroy: vi.fn(),
              write: (line: string) => {
                const cmd = JSON.parse(line);
                commands.push(cmd);
                if (cmd.cmd === "watch") options.watch?.(cmd);
                queueMicrotask(() =>
                  socket.emit("data", `${JSON.stringify(reply)}\n`),
                );
              },
            });
            queueMicrotask(() => {
              if (reply === "timeout") return;
              if (typeof reply === "string")
                socket.emit("error", { code: reply });
              else socket.emit("connect");
            });
            return socket;
          },
        };
      throw Error(`unexpected require ${name}`);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(hooksDir, "watch-lease.js"), "utf8"),
    context,
  );
  return {
    api: context.module.exports as LeaseApi,
    commands,
    spawns,
    connectionCount: () => connections,
  };
}
const input = { session_id: "one", cwd: "/project/src" };

afterEach(() => vi.useRealTimers());
describe("Claude hook singleton and session ownership", () => {
  it.each(["env", "file"] as const)(
    "honors %s quarantine before any IPC or spawn",
    async (disabled) => {
      const h = helper({ disabled });
      expect(
        await h.api.ensureSessionLease(input, input.cwd, { allowStart: true }),
      ).toBe(false);
      expect(h.connectionCount()).toBe(0);
      expect(h.spawns).toEqual([]);
    },
  );

  it.each([
    "EPERM",
    "EACCES",
    { ok: false, error: "daemon initializing" },
    { ok: false, error: "DAEMON_BUSY" },
    { ok: true },
  ])(
    "does not start beside a live, denied or incompatible socket: %j",
    async (reply) => {
      const h = helper({ replies: [reply] });
      expect(
        await h.api.ensureSessionLease(input, input.cwd, { allowStart: true }),
      ).toBe(false);
      expect(h.spawns).toEqual([]);
      expect(h.commands.every((cmd) => cmd.cmd === "ping")).toBe(true);
    },
  );

  it("does not spawn after a ping timeout", async () => {
    vi.useFakeTimers();
    const h = helper({ replies: ["timeout"] });
    const request = h.api.ensureSessionLease(input, input.cwd, {
      allowStart: true,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(await request).toBe(false);
    expect(h.spawns).toEqual([]);
  });

  it.each(["ENOENT", "ECONNREFUSED"])(
    "starts only one daemon after %s, never a per-project watcher",
    async (reply) => {
      const h = helper({ replies: [reply, live, { ok: true }] });
      expect(
        await h.api.ensureSessionLease(input, input.cwd, { allowStart: true }),
      ).toBe(true);
      expect(h.spawns).toEqual([
        { args: ["watch", "--daemon", "-b"], cwd: input.cwd },
      ]);
      expect(h.commands[h.commands.length - 1]).toMatchObject({
        cmd: "watch",
        root: "/project",
        holder: "session:one",
        ttlMs: 4 * 3600 * 1000,
      });
    },
  );

  it("does not fall back when daemon executable cannot start", async () => {
    const h = helper({ replies: ["ENOENT"], failSpawn: true });
    expect(
      await h.api.ensureSessionLease(input, input.cwd, { allowStart: true }),
    ).toBe(false);
    expect(h.spawns).toHaveLength(1);
  });

  it("bounds cold-start polling and leaves later activity to retry", async () => {
    vi.useFakeTimers();
    const h = helper({
      replies: ["ENOENT", { ok: false, error: "daemon initializing" }],
    });
    const request = h.api.ensureSessionLease(input, input.cwd, {
      allowStart: true,
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(await request).toBe(false);
    expect(h.spawns).toHaveLength(1);
    expect(h.commands.some((cmd) => cmd.cmd === "watch")).toBe(false);
  });

  it("reuses the most specific registered root and rejects prefix siblings", async () => {
    const h = helper();
    expect(h.api.registeredRootFor("/project/nested/src")).toBe(
      "/project/nested",
    );
    expect(h.api.registeredRootFor("/project-copy")).toBeNull();
    expect(
      await h.api.ensureSessionLease(input, "/project-copy", {
        allowStart: true,
      }),
    ).toBe(false);
    expect(h.connectionCount()).toBe(0);
    expect(await h.api.ensureSessionLease(input, "/project/nested/src")).toBe(
      true,
    );
    expect(h.commands[h.commands.length - 1]?.root).toBe("/project/nested");
    expect(h.spawns).toEqual([]);
  });

  it("renews a long session and releases only its own lease", async () => {
    let now = 0;
    const leases = new WatchLeases(null, { now: () => now });
    const h = helper({
      watch: (cmd) =>
        leases.acquire(String(cmd.root), {
          holder: String(cmd.holder),
          ttlMs: Number(cmd.ttlMs),
        }),
    });
    await h.api.ensureSessionLease(input, input.cwd);
    leases.acquire("/project", {
      holder: "session:two",
      ttlMs: 6 * 3600 * 1000,
    });
    now = 3.9 * 3600 * 1000;
    await h.api.ensureSessionLease(input, input.cwd);
    now = 4.1 * 3600 * 1000;
    expect(leases.list().map((lease) => lease.holder)).toContain("session:one");
    await h.api.releaseSessionLeases(input, input.cwd);
    expect(h.commands[h.commands.length - 1]).toMatchObject({
      cmd: "unwatch",
      root: "/project",
      holder: "session:one",
    });
    leases.release(
      "/project",
      String(h.commands[h.commands.length - 1]?.holder),
    );
    expect(leases.list().map((lease) => lease.holder)).toEqual(["session:two"]);
  });

  it("never sends an unscoped release to an older daemon", async () => {
    const h = helper({ replies: [{ ok: true }] });
    expect(await h.api.releaseSessionLeases(input, input.cwd)).toBe(false);
    expect(h.commands).toEqual([{ cmd: "ping" }]);
  });
});

async function entry(file: string, data: Input) {
  const calls: unknown[][] = [];
  const helpers = {
    readHookInput: async () => data,
    registeredRootFor: (cwd: string) =>
      cwd.startsWith("/project/")
        ? "/project"
        : cwd.startsWith("/other/")
          ? "/other"
          : null,
    ensureSessionLease: async (...args: unknown[]) =>
      calls.push(["ensure", ...args]),
    releaseSessionLeases: async (...args: unknown[]) =>
      calls.push(["release", ...args]),
  };
  const context: Record<string, unknown> = {
    __dirname: hooksDir,
    process: { cwd: () => "/wrong", stdout: { write: vi.fn() } },
    require: (name: string) => {
      if (name === "./watch-lease") return helpers;
      if (name === "node:path") return path;
      if (name === "node:fs") return {};
      if (name === "node:child_process")
        return {
          execFileSync: () => {
            throw Error("not on PATH");
          },
        };
      throw Error("unavailable");
    },
  };
  vm.runInNewContext(
    fs
      .readFileSync(path.join(hooksDir, file), "utf8")
      .replace(/main\(\);\s*$/, "globalThis.done=main();"),
    context,
  );
  await context.done;
  return calls;
}

describe("Claude entrypoints and quoted installation paths", () => {
  it.each(["start.js", "activity.js"])(
    "%s passes the session input cwd into shared safe startup",
    async (file) => {
      const calls = await entry(file, input);
      expect(calls).toEqual([
        ["ensure", input, input.cwd, { allowStart: true }],
      ]);
    },
  );
  it("releases the previous registered project before acquiring the new one", async () => {
    const data = { ...input, old_cwd: "/project/src", new_cwd: "/other/src" };
    expect(await entry("cwd-changed.js", data)).toEqual([
      ["release", data, data.old_cwd],
      ["ensure", data, data.new_cwd, { allowStart: true }],
    ]);
  });
  it("runs installed hooks from a path containing spaces without starting production work", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax plugin path "));
    try {
      fs.cpSync(hooksDir, path.join(root, "hooks"), { recursive: true });
      const manifest = JSON.parse(
        fs.readFileSync("plugins/grepmax/hooks.json", "utf8"),
      );
      for (const event of Object.values(manifest.hooks) as {
        hooks: { command: string }[];
      }[][]) {
        for (const rule of event)
          for (const hook of rule.hooks) {
            execFileSync("/bin/sh", ["-c", hook.command], {
              cwd: root,
              input: JSON.stringify({ session_id: "synthetic", cwd: root }),
              timeout: 5000,
              env: {
                ...process.env,
                CLAUDE_PLUGIN_ROOT: root,
                GMAX_NO_AUTOSTART: "1",
              },
            });
          }
      }
      expect(manifest.hooks.PostToolUse[0].matcher).toBe("Bash");
      expect(manifest.hooks.UserPromptSubmit).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
