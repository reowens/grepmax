import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Runs the real SessionStart hook against a stand-in daemon socket in a
// throwaway HOME, so the timings are the hook's own.
const startHook = path.resolve("plugins/grepmax/hooks/start.js");
const LEASE_LINE = "has not confirmed this session's watch lease";

type Setup = { home: string; project: string; bin: string };
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(): Setup {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-hook-"));
  const project = path.join(home, "project");
  const bin = path.join(home, "bin");
  fs.mkdirSync(path.join(home, ".gmax"));
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(home, ".gmax", "projects.json"),
    JSON.stringify([{ root: project, status: "indexed", chunkCount: 12 }]),
  );
  // Records that the hook asked for a daemon, then exits like a launcher
  // that found nothing to start.
  fs.writeFileSync(
    path.join(bin, "gmax"),
    `#!/bin/sh\necho "$@" >> "${path.join(home, "spawned")}"\n`,
    { mode: 0o755 },
  );
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, project, bin };
}

async function fakeDaemon(home: string, watchDelayMs: number) {
  const commands: Record<string, unknown>[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const cmd = JSON.parse(buffer.slice(0, newline));
      commands.push(cmd);
      const reply =
        cmd.cmd === "ping"
          ? { ok: true, ready: true, capabilities: { watchLeases: 1 } }
          : { ok: true };
      const timer = setTimeout(
        () => conn.end(`${JSON.stringify(reply)}\n`),
        cmd.cmd === "watch" ? watchDelayMs : 0,
      );
      timers.add(timer);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(path.join(home, ".gmax", "daemon.sock"), resolve),
  );
  cleanups.push(() => {
    for (const timer of timers) clearTimeout(timer);
    server.close();
  });
  return commands;
}

function runStart({ home, project, bin }: Setup) {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
  };
  const started = Date.now();
  const child = spawn(process.execPath, [startHook], { cwd: project, env });
  child.stdin.end(
    JSON.stringify({
      session_id: "one",
      cwd: project,
      hook_event_name: "SessionStart",
    }),
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  return new Promise<{ ms: number; context: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () =>
      resolve({
        ms: Date.now() - started,
        context: JSON.parse(stdout).hookSpecificOutput.additionalContext,
      }),
    );
  });
}

describe("SessionStart hook time budget", () => {
  it("takes the lease and adds nothing when the daemon answers", async () => {
    const s = setup();
    const commands = await fakeDaemon(s.home, 0);
    const { context } = await runStart(s);
    expect(context).toMatch(/^Gmax current repo: .*; daemon=ready\.$/m);
    expect(context).not.toContain(LEASE_LINE);
    expect(commands).toContainEqual(
      expect.objectContaining({ cmd: "watch", holder: "session:one" }),
    );
  });

  it("stops waiting for a watch reply that is held for seconds", async () => {
    const s = setup();
    const commands = await fakeDaemon(s.home, 5000);
    const { ms, context } = await runStart(s);
    expect(ms).toBeLessThan(1500);
    expect(context).toContain("daemon=ready.");
    expect(context).toContain(LEASE_LINE);
    // The daemon records the lease when the line arrives.
    expect(commands).toContainEqual(
      expect.objectContaining({ cmd: "watch", holder: "session:one" }),
    );
  });

  it("requests a daemon start without waiting for it when none is running", async () => {
    const s = setup();
    const { ms, context } = await runStart(s);
    expect(ms).toBeLessThan(1000);
    expect(context).toContain("daemon=offline.");
    expect(context).toContain(LEASE_LINE);
    await expect
      .poll(() => fs.existsSync(path.join(s.home, "spawned")))
      .toBe(true);
    expect(fs.readFileSync(path.join(s.home, "spawned"), "utf8").trim()).toBe(
      "watch --daemon -b",
    );
  });
});
