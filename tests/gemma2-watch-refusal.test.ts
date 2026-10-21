import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

it.each([
  { args: ["--daemon"], mode: "configured" },
  { args: ["--daemon", "--read-only"], mode: "configured" },
  { args: ["restart", "--json"], mode: "configured" },
  { args: ["--daemon"], mode: "incomplete" },
  { args: ["restart", "--json"], mode: "incomplete" },
  { args: ["--daemon"], mode: "missing" },
])(
  "refuses Gemma watcher before discovery or IPC: $mode $args",
  ({ args, mode }) => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "gmax-gemma-watch-")),
    );
    try {
      if (mode !== "missing")
        fs.writeFileSync(
          path.join(directory, "config.json"),
          mode === "incomplete"
            ? "{"
            : JSON.stringify({
                modelTier: "gemma2",
                vectorDim: 768,
                embedMode: "gpu",
              }),
        );
      const guard = path.join(directory, "guard.cjs");
      fs.writeFileSync(
        guard,
        `
   const cp=require('node:child_process');
   for(const key of ['spawn','fork','exec','execFile','execSync','execFileSync'])cp[key]=()=>{throw Error('fixture forbids subprocesses: '+key)};
   require('node:net').createConnection=()=>{throw Error('fixture forbids IPC')};
   require('node:net').createServer=()=>{throw Error('fixture forbids listeners')};
   const signal=process.kill.bind(process);process.kill=(pid,sig)=>{if(pid!==process.pid&&sig!==0)throw Error('fixture forbids external signals');return signal(pid,sig)};
   require('node:module').syncBuiltinESMExports();
  `,
      );
      const code = `import('./src/commands/watch.ts').then(({watch})=>watch.parseAsync(${JSON.stringify(args)},{from:'user'}))`;
      let output = "";
      try {
        execFileSync(
          process.execPath,
          [
            "--require",
            guard,
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            code,
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              GMAX_GEMMA_PROFILE: mode === "configured" ? "0" : "1",
              GMAX_HOME: directory,
              GMAX_NO_AUTOSTART: "0",
            },
            timeout: 20000,
            killSignal: "SIGKILL",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        throw Error("unexpected startup success");
      } catch (error) {
        const e = error as {
          status?: number;
          stdout?: Buffer;
          stderr?: Buffer;
        };
        expect(e.status).toBe(2);
        output = String(e.stdout ?? "") + String(e.stderr ?? "");
      }
      expect(output).toMatch(/Gemma profiles run in-process/);
      expect(output).not.toMatch(/fixture forbids/);
      expect(fs.existsSync(path.join(directory, "daemon.pid"))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
