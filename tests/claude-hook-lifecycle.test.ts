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
      if (name === "./repo-status")
        return {
          getRepoStatus: async () => ({ indexState: "indexed" }),
          formatRepoContext: () => "synthetic repo context",
        };
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

function repoContext(
  indexState: string,
  daemonState = "unobserved",
  cliHint: string | null = null,
) {
  // Loading the formatter must not access metadata, sockets or the live home.
  const context = {
    module: {
      exports: {} as { formatRepoContext: (status: unknown) => string },
    },
    require: (name: string) => {
      if (name === "node:fs" || name === "node:net") return {};
      if (name === "node:os") return { homedir: () => "/synthetic" };
      if (name === "node:path") return path;
      throw Error(`unexpected status access: ${name}`);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(hooksDir, "repo-status.js"), "utf8"),
    context,
  );
  return context.module.exports.formatRepoContext({
    repoRoot: "/project",
    matchedRoot: indexState === "not_registered" ? null : "/project",
    indexState,
    cachedChunks: 12,
    daemon: { state: daemonState },
    cliHint,
  });
}

async function preGrep(
  pattern: unknown,
  cliHint: string | null = "gmax \"<concept>\" --root '/project' --agent",
) {
  const write = vi.fn();
  const readRepoStatus = vi.fn(() => ({ cliHint }));
  const stdin = new EventEmitter();
  Object.assign(stdin, { setEncoding: vi.fn() });
  const context: Record<string, unknown> = {
    process: { stdin, cwd: () => "/project", stdout: { write } },
    // Input is supplied immediately; no real hook timeout is needed.
    setTimeout: vi.fn(),
    require: (name: string) => {
      if (name === "./repo-status") return { readRepoStatus };
      throw Error(`unexpected require ${name}`);
    },
  };
  vm.runInNewContext(
    fs
      .readFileSync(path.join(hooksDir, "pre-grep.js"), "utf8")
      .replace(/main\(\);\s*$/, "globalThis.done=main();"),
    context,
  );
  stdin.emit(
    "data",
    JSON.stringify({ cwd: "/project", tool_input: { pattern } }),
  );
  stdin.emit("end");
  await context.done;
  return { write, readRepoStatus };
}

describe("Claude semantic discovery guidance", () => {
  it("directs indexed-repo behavior questions to gmax, then Read", () => {
    const text = repoContext(
      "indexed",
      "unobserved",
      "gmax \"<concept>\" --root '/project' --agent",
    );
    expect(text).toContain("This repo has a semantic index");
    expect(text).toContain("when you do not know the exact name");
    expect(text).toContain(
      "run gmax \"<question in plain words>\" --root '/project' --agent first",
    );
    expect(text).toContain("then Read the file:line pointers");
    expect(text).toContain("Use Grep for exact names");
    expect(text).toContain(
      "freshness and embedding compatibility are unverified",
    );
    expect(text).toContain("does not register an MCP server");
    expect(text).toContain(
      "explicit query limits and model/startup restrictions still apply",
    );
    expect(text).not.toContain("suggest an advertised");
  });

  it.each([
    "pending",
    "error",
    "legacy_unknown",
    "metadata_unavailable",
    "store_unavailable",
    "unknown",
  ])("keeps %s readiness unverified without a search instruction", (state) => {
    const text = repoContext(state);
    expect(text).toContain("Current-repo search readiness is unverified");
    expect(text).not.toContain("This repo has a semantic index");
    expect(text).not.toContain("run gmax");
  });

  it("preserves not-registered and offline caveats", () => {
    const absent = repoContext("not_registered");
    expect(absent).toContain("Other registered projects do not cover it");
    expect(absent).not.toContain("run gmax");
    for (const state of ["offline", "paused", "initializing"]) {
      expect(repoContext("indexed", state)).toContain(
        "Daemon state does not establish query readiness. Do not start services or load models",
      );
    }
    expect(repoContext("indexed")).not.toContain("run gmax");
  });

  it.each([
    "where authentication happens",
    "heartbeat|ping|keepalive",
    "(?i)reconnect|resubscribe|restore",
    "dosdevices|sandbox|wine",
    // Patterns an agent actually grepped while guessing at a behavior.
    "(?i)keep.?alive|NoOp|heartbeat|ping",
    "(?i)reconnect|resubscribe|re-?login|restore",
    "(?i)(dry.?run|confirm|read.?only|allow.?write|safe)",
    "keep.?alive|heartbeat|ping",
    "(heartbeat|ping|keepalive)",
  ])(
    "adds informational context for %s without blocking or modifying Grep",
    async (pattern) => {
      const { write, readRepoStatus } = await preGrep(pattern);
      expect(readRepoStatus).toHaveBeenCalledWith("/project");
      expect(write).toHaveBeenCalledTimes(1);
      const output = JSON.parse(write.mock.calls[0][0]);
      expect(Object.keys(output)).toEqual(["hookSpecificOutput"]);
      expect(Object.keys(output.hookSpecificOutput)).toEqual([
        "hookEventName",
        "additionalContext",
      ]);
      expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(output.hookSpecificOutput.additionalContext).toBe(
        "This repo has a semantic index: when you are guessing names for a behavior, run gmax \"<question in plain words>\" --root '/project' --agent first (requires gmax on PATH), then Read the file:line pointers it returns. Use Grep for exact names and honor explicit query/startup limits.",
      );
    },
  );

  it.each([
    "heartbeat",
    "heartbeat ping",
    "heartbeat|ping",
    "heartbeat|ping|",
    "keepAlive",
    "NoOp|heartbeat|ping",
    "KEEPALIVE|HEARTBEAT|PING",
    "keep_alive|heartbeat|ping",
    "src/auth/handler",
    "src/auth handler code",
    "src/auth|lib/auth|test/auth",
    "foo.bar|heartbeat|ping",
    "dosdevices|sandbox|z:",
    "class|function|import",
    "UserService|AuthGuard|JwtStrategy",
    "const auth handler",
    '"where auth happens"',
    "auth.handler handles requests",
    null,
    42,
  ])(
    "leaves literal, identifier and code pattern %j alone",
    async (pattern) => {
      const { write, readRepoStatus } = await preGrep(pattern);
      expect(write).not.toHaveBeenCalled();
      expect(readRepoStatus).not.toHaveBeenCalled();
    },
  );

  it("does not suggest a search without a current-repo CLI hint", async () => {
    const { write } = await preGrep("heartbeat|ping|keepalive", null);
    expect(write).not.toHaveBeenCalled();
  });
});

const preBashMarkers = new Map<string, number>();

async function preBash(command: string, sessionId = "session") {
  const write = vi.fn();
  const readRepoStatus = vi.fn(() => ({
    cliHint: "gmax \"<concept>\" --root '/project' --agent",
  }));
  const stdin = new EventEmitter();
  Object.assign(stdin, { setEncoding: vi.fn() });
  const context: Record<string, unknown> = {
    process: { stdin, cwd: () => "/project", stdout: { write } },
    setTimeout: vi.fn(),
    Date,
    require: (name: string) => {
      if (name === "./repo-status") return { readRepoStatus };
      if (name === "path") return path;
      if (name === "os") return { tmpdir: () => "/tmp" };
      if (name === "fs") {
        return {
          statSync: (marker: string) => {
            if (!preBashMarkers.has(marker)) throw Error("missing");
            return { mtimeMs: preBashMarkers.get(marker) };
          },
          writeFileSync: (marker: string) =>
            preBashMarkers.set(marker, Date.now()),
        };
      }
      throw Error(`unexpected require ${name}`);
    },
  };
  vm.runInNewContext(
    fs
      .readFileSync(path.join(hooksDir, "pre-grep.js"), "utf8")
      .replace(/main\(\);\s*$/, "globalThis.done=main();"),
    context,
  );
  stdin.emit(
    "data",
    JSON.stringify({
      cwd: "/project",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command },
    }),
  );
  stdin.emit("end");
  await context.done;
  return write;
}

describe("Claude semantic discovery guidance on shell searches", () => {
  it.each([
    'rg "keep.?alive|heartbeat|ping" src',
    'rg -n "how are sessions renewed" packages',
    'grep -rE "retry\\|backoff\\|reconnect" src',
    'cd src && rg "login|session|token"',
  ])("suggests gmax for %s", async (command) => {
    const write = await preBash(command, `yes-${command}`);
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(write.mock.calls[0][0]).hookSpecificOutput.additionalContext,
    ).toContain("Use rg for exact names");
  });

  it.each([
    'ls | rg "login|session|token"',
    'rg -F "how are sessions renewed"',
    'rg "login|session|token" app.log',
    'rg "login|session|token" .dev/logs',
    'rg "login|session|token" src/a.ts',
    'rg "login|session|token" /elsewhere',
    'grep "login|session|token" src',
    "rg createDb",
    'rg "createDb|allowProd|host"',
    'cat <<E\nrg "login|session|token"\nE',
    'echo rg "login|session|token"',
    "rg --files",
    "git status",
  ])("stays quiet for %s", async (command) => {
    expect(await preBash(command, `no-${command}`)).not.toHaveBeenCalled();
  });

  it("repeats a hint at most once per 30 minutes per session", async () => {
    const command = 'rg "login|session|token"';
    expect(await preBash(command, "repeat")).toHaveBeenCalledTimes(1);
    expect(await preBash(command, "repeat")).not.toHaveBeenCalled();
    expect(await preBash(command, "other")).toHaveBeenCalledTimes(1);
  });
});
