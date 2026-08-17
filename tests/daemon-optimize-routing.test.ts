import { describe, expect, it, vi } from "vitest";
import { handleCommand } from "../src/lib/daemon/ipc-handler";

// Lance's optimize runs with deleteUnverified: true, which its docs say is only
// safe with a single writer on the dataset. gmax is multi-process, so that
// guarantee has to come from routing: with a daemon up it is the only
// optimizer, and CLI callers ask it rather than compacting alongside it.
describe("optimize IPC routing", () => {
  function fakeDaemon(overrides: Record<string, unknown> = {}) {
    return {
      operationStatus: () => "idle",
      isReady: () => true,
      runOptimize: vi.fn(async () => ({ ok: true as const })),
      ...overrides,
    } as any;
  }

  it("routes an optimize command to the daemon", async () => {
    const daemon = fakeDaemon();
    const resp = await handleCommand(daemon, { cmd: "optimize" }, {} as any);
    expect(daemon.runOptimize).toHaveBeenCalledTimes(1);
    expect(resp).toMatchObject({ ok: true });
  });

  it("surfaces a daemon-side failure instead of reporting success", async () => {
    const daemon = fakeDaemon({
      runOptimize: vi.fn(async () => {
        throw new Error("daemon resources not ready");
      }),
    });
    const resp = await handleCommand(daemon, { cmd: "optimize" }, {} as any);
    expect(resp?.ok).toBe(false);
  });

  // A daemon too old to know the command still holds the store, so the client
  // must tell that apart from "nothing is listening" — it decides between
  // skipping and optimizing in-process, and getting it wrong means two writers.
  it("rejects an unrecognized command with an unknown-command error", async () => {
    const resp = await handleCommand(
      fakeDaemon(),
      { cmd: "definitely-not-a-command" },
      {} as any,
    );
    expect(resp?.ok).toBe(false);
    expect(String(resp?.error)).toContain("unknown command");
  });

  // "daemon initializing" also means a live daemon — the client must not read it
  // as absence and start compacting in-process alongside it.
  it("reports initializing distinctly from absence", async () => {
    const resp = await handleCommand(
      fakeDaemon({ isReady: () => false }),
      { cmd: "optimize" },
      {} as any,
    );
    expect(resp?.ok).toBe(false);
    expect(String(resp?.error)).toContain("initializing");
    expect(String(resp?.error)).not.toMatch(/ECONNREFUSED|ENOENT/);
  });
});
