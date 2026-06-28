import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/daemon-client", () => ({
  isDaemonDraining: vi.fn(() => false),
  isDaemonHeartbeatFresh: vi.fn(() => false),
  isDaemonRunning: vi.fn(async () => false),
}));

vi.mock("../src/lib/utils/process", () => ({
  killProcess: vi.fn(async () => {}),
}));

import { ProcessManager } from "../src/lib/daemon/process-manager";
import {
  isDaemonDraining,
  isDaemonHeartbeatFresh,
  isDaemonRunning,
} from "../src/lib/utils/daemon-client";
import { killProcess } from "../src/lib/utils/process";

const OLD_DAEMON_PID = 12345;
const OLD_WORKER_PID = 999;

function makeManager(): ProcessManager {
  const pm = new ProcessManager({ getShuttingDown: () => false });
  // Pretend the OS reports one other daemon and one worker.
  vi.spyOn(pm, "findProcessesByTitle").mockImplementation((title: string) =>
    title === "gmax-daemon" ? [OLD_DAEMON_PID] : [OLD_WORKER_PID],
  );
  return pm;
}

// process.exit must halt; a no-op mock would let code run past it. Throw a
// sentinel instead so the caller stops exactly where the real exit would.
class ExitSignal extends Error {
  constructor(public code: number | undefined) {
    super(`exit:${code}`);
  }
}

describe("killStaleProcesses draining handoff", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDaemonHeartbeatFresh).mockReturnValue(false);
    vi.mocked(isDaemonRunning).mockResolvedValue(false);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as never);
  });

  it("does not kill a peer that is gracefully draining, and takes over", async () => {
    vi.mocked(isDaemonDraining).mockReturnValue(true);

    await makeManager().killStaleProcesses();

    // The draining peer is left to finish its own teardown, its workers are not
    // swept (it's reaping them itself), and the successor takes over rather than
    // deferring (exit) to it.
    expect(killProcess).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("still kills a truly-stale (non-draining, unresponsive) peer and its workers", async () => {
    vi.mocked(isDaemonDraining).mockReturnValue(false);

    await makeManager().killStaleProcesses();

    expect(killProcess).toHaveBeenCalledWith(OLD_DAEMON_PID);
    expect(killProcess).toHaveBeenCalledWith(OLD_WORKER_PID);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("defers (exits) to a healthy, responsive peer without killing it", async () => {
    vi.mocked(isDaemonDraining).mockReturnValue(false);
    vi.mocked(isDaemonRunning).mockResolvedValue(true);

    await expect(makeManager().killStaleProcesses()).rejects.toBeInstanceOf(
      ExitSignal,
    );

    // exit(0) halts before any kill — the live peer is untouched.
    expect(killProcess).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
