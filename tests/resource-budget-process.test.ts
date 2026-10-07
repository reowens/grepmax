import { type ChildProcess, fork } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

it("two real clients cannot reserve the same shared headroom", async () => {
  // Two lightweight Node children, injected measurements, no native store or
  // model. Peak test allocation is bounded by two 64MiB JS heaps.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-budget-process-"));
  const children: ChildProcess[] = [];
  try {
    const fixture = path.join(__dirname, "fixtures/resource-budget-child.cjs");
    const ready = Array.from(
      { length: 2 },
      () =>
        new Promise<ChildProcess>((resolve, reject) => {
          const child = fork(fixture, {
            execArgv: [
              "--max-old-space-size=64",
              "--import",
              require.resolve("tsx"),
            ],
            env: { ...process.env, GMAX_RESOURCE_BUDGET_MB: "2048" },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          });
          children.push(child);
          child.once("error", reject);
          child.once("message", () => resolve(child));
        }),
    );
    await Promise.all(ready);
    const results = await Promise.all(
      children.map(
        (child) =>
          new Promise<{ admitted: boolean; reason?: string }>((resolve) => {
            child.once("message", resolve);
            child.send({ cmd: "go", root, pids: children.map((c) => c.pid) });
          }),
      ),
    );
    expect(results.filter((r) => r.admitted)).toHaveLength(1);
    expect(results.find((r) => !r.admitted)?.reason).toMatch(
      /budget exceeded|admission busy/,
    );
    expect(
      fs.readdirSync(root).filter((n) => n.endsWith(".json")),
    ).toHaveLength(1);
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("close", () => resolve());
            child.send({ cmd: "close" });
          }),
      ),
    );
    expect(
      fs.readdirSync(root).filter((n) => n.endsWith(".json")),
    ).toHaveLength(0);
  } finally {
    for (const child of children) if (child.connected) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
