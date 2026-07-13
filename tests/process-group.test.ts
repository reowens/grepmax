import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateProcessGroup } from "../src/lib/utils/process";

describe("terminateProcessGroup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns after graceful SIGTERM without escalating", async () => {
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 0) {
        const error = new Error("gone") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as typeof process.kill);

    await expect(terminateProcessGroup(1234)).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-1234, "SIGKILL");
  });

  it("escalates a group that ignores SIGTERM", async () => {
    vi.useFakeTimers();
    let killed = false;
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === "SIGKILL") killed = true;
      if (signal === 0 && killed) {
        const error = new Error("gone") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as typeof process.kill);

    const result = terminateProcessGroup(1234, {
      termTimeoutMs: 200,
      killTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(300);

    await expect(result).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-1234, "SIGKILL");
  });
});
