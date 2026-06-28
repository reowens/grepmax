import { describe, expect, it, vi } from "vitest";

// commandExists() probes clients with `which <cmd>` via execSync. Throw for
// every probe so no client is detected — installAll() then performs zero real
// installs (no spawning `claude plugin ...`), keeping this test side-effect free.
// Factory Droid's detect is `existsSync(.factory) && commandExists("droid")`, so
// a false commandExists short-circuits it regardless of the filesystem.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(() => {
      throw new Error("not found");
    }),
  };
});

import { installAll } from "../src/commands/plugin";

describe("installAll", () => {
  it("returns a count and never exits the process (so setup's outro runs)", async () => {
    // The finding-9 bug routed setup through statusAction()/gracefulExit(),
    // killing the process before setup could finish. installAll() must return
    // control instead.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    const count = await installAll();

    expect(count).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
