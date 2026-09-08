import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asStoreAccessError,
  classifyDaemonError,
  classifyLeaseError,
  isStoreAccessRefused,
  isUnknownCommandError,
  LEASE_DENIED_MESSAGE,
  leaseDeniedMessage,
  probeStoreWritable,
  reportStoreAccessRefusal,
  resetStoreWriteDeniedNotice,
  SOCKET_DENIED_MESSAGE,
  shouldFallbackFromDaemonError,
  socketDeniedMessage,
  storeWriteDeniedNotice,
  warnStoreWriteDeniedOnce,
  withStoreRead,
} from "../src/lib/utils/store-access";

function errno(
  code: string,
  message = `${code}: denied`,
): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
  delete process.env.GMAX_NO_DAEMON;
  resetStoreWriteDeniedNotice();
  vi.restoreAllMocks();
});

describe("classifyDaemonError", () => {
  it("treats only ENOENT/ECONNREFUSED as proof that no daemon exists", () => {
    expect(classifyDaemonError("ENOENT")).toBe("no-daemon");
    expect(classifyDaemonError("ECONNREFUSED")).toBe("no-daemon");
  });

  it("treats socket denials as sandboxed", () => {
    for (const code of ["EPERM", "EACCES", "EROFS"]) {
      expect(classifyDaemonError(code)).toBe("sandboxed");
      expect(classifyDaemonError(errno(code))).toBe("sandboxed");
    }
  });

  it("reports every live-daemon failure as a daemon error", () => {
    for (const error of [
      "timeout",
      "connection closed",
      "DAEMON_BUSY",
      "DAEMON_CLOSING",
      "invalid response",
      "unknown command: graph.resolve",
      "aborted",
    ]) {
      expect(classifyDaemonError(error)).toBe("daemon-error");
    }
  });

  it("reports the absence of an error as ok", () => {
    expect(classifyDaemonError(undefined)).toBe("ok");
    expect(classifyDaemonError(null)).toBe("ok");
  });
});

describe("classifyLeaseError", () => {
  it("classifies denial errnos as sandboxed", () => {
    for (const code of ["EPERM", "EACCES", "EROFS"]) {
      expect(classifyLeaseError(errno(code))).toBe("sandboxed");
    }
  });

  it("classifies the fs and LMDB denial message shapes as sandboxed", () => {
    expect(
      classifyLeaseError(
        new Error(
          "EPERM: operation not permitted, mkdir '/x/lancedb.lease.lock'",
        ),
      ),
    ).toBe("sandboxed");
    expect(
      classifyLeaseError(
        new Error("Operation not permitted: Attempting to setup locks"),
      ),
    ).toBe("sandboxed");
  });

  it("leaves ordinary failures alone", () => {
    expect(classifyLeaseError(errno("ENOENT"))).toBe("other");
    expect(classifyLeaseError(new Error("Daemon search failed: EPERM"))).toBe(
      "other",
    );
  });
});

describe("refusal messages", () => {
  it("names the exact settings key for each denial", () => {
    expect(socketDeniedMessage()).toBe(SOCKET_DENIED_MESSAGE);
    expect(leaseDeniedMessage()).toBe(LEASE_DENIED_MESSAGE);
    expect(SOCKET_DENIED_MESSAGE).toContain("allowUnixSockets");
    expect(SOCKET_DENIED_MESSAGE).toContain("~/.gmax/daemon.sock");
    expect(LEASE_DENIED_MESSAGE).toContain("allowWrite");
    expect(LEASE_DENIED_MESSAGE).toContain("~/.gmax");
  });

  it("prints a refusal as one line and exits 2", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = asStoreAccessError(errno("EPERM"));
    expect(isStoreAccessRefused(refused)).toBe(true);
    expect(reportStoreAccessRefusal(refused)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(LEASE_DENIED_MESSAGE);
    expect(process.exitCode).toBe(2);
  });

  it("passes non-refusals through untouched", () => {
    const other = new Error("boom");
    expect(asStoreAccessError(other)).toBe(other);
    expect(reportStoreAccessRefusal(other)).toBe(false);
  });
});

describe("withStoreRead", () => {
  it("returns the rendered daemon answer when the daemon replies ok", async () => {
    const inProcess = vi.fn();
    const value = await withStoreRead("status", {
      daemon: async () => ({ ok: true, projects: ["a"] }),
      render: (resp) => (resp.projects as string[]).length,
      inProcess,
    });
    expect(value).toBe(1);
    expect(inProcess).not.toHaveBeenCalled();
  });

  it("falls back in-process only when nothing is listening", async () => {
    for (const error of ["ENOENT", "ECONNREFUSED"]) {
      const inProcess = vi.fn(async () => "local");
      const value = await withStoreRead("status", {
        daemon: async () => ({ ok: false, error }),
        inProcess,
      });
      expect(value).toBe("local");
      expect(inProcess).toHaveBeenCalledOnce();
    }
  });

  it("refuses without opening the store when the socket is denied", async () => {
    const inProcess = vi.fn();
    await expect(
      withStoreRead("status", {
        daemon: async () => ({ ok: false, error: "EPERM" }),
        inProcess,
      }),
    ).rejects.toMatchObject({ name: "StoreAccessRefused", kind: "socket" });
    expect(inProcess).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("refuses when the socket connect throws a denial", async () => {
    const inProcess = vi.fn();
    await expect(
      withStoreRead("status", {
        daemon: async () => {
          throw errno("EACCES");
        },
        inProcess,
      }),
    ).rejects.toMatchObject({ kind: "socket" });
    expect(inProcess).not.toHaveBeenCalled();
  });

  it("never opens the store after a live-daemon error", async () => {
    const inProcess = vi.fn();
    await expect(
      withStoreRead("graph.trace", {
        daemon: async () => ({ ok: false, error: "DAEMON_BUSY" }),
        inProcess,
      }),
    ).rejects.toThrow(/Daemon graph.trace failed: DAEMON_BUSY/);
    expect(inProcess).not.toHaveBeenCalled();
  });

  it("falls back for an unknown verb only when the caller opted in", async () => {
    const optedIn = vi.fn(async () => "local");
    await expect(
      withStoreRead("graph.trace", {
        daemon: async () => ({
          ok: false,
          error: "unknown command: graph.trace",
        }),
        inProcess: optedIn,
        fallbackOnUnknownVerb: true,
      }),
    ).resolves.toBe("local");

    const optedOut = vi.fn();
    await expect(
      withStoreRead("search-v2", {
        daemon: async () => ({
          ok: false,
          error: "unknown command: search-v2",
        }),
        inProcess: optedOut,
      }),
    ).rejects.toThrow(/unknown command/);
    expect(optedOut).not.toHaveBeenCalled();
  });

  it("converts an in-process lease denial into the filesystem refusal", async () => {
    await expect(
      withStoreRead("status", {
        daemon: async () => ({ ok: false, error: "ENOENT" }),
        inProcess: async () => {
          throw new Error("Operation not permitted: Attempting to setup locks");
        },
      }),
    ).rejects.toMatchObject({ name: "StoreAccessRefused", kind: "lease" });
    expect(process.exitCode).toBe(2);
  });

  it("GMAX_NO_DAEMON=1 skips the daemon attempt entirely", async () => {
    process.env.GMAX_NO_DAEMON = "1";
    const daemon = vi.fn();
    await expect(
      withStoreRead("status", {
        daemon,
        inProcess: async () => "local",
      }),
    ).resolves.toBe("local");
    expect(daemon).not.toHaveBeenCalled();
  });
});

describe("shouldFallbackFromDaemonError (search-run's historical predicate)", () => {
  it("agrees with the no-daemon class only", () => {
    expect(shouldFallbackFromDaemonError("ENOENT")).toBe(true);
    expect(shouldFallbackFromDaemonError("ECONNREFUSED")).toBe(true);
    expect(shouldFallbackFromDaemonError("EPERM")).toBe(false);
    expect(shouldFallbackFromDaemonError("timeout")).toBe(false);
  });
});

describe("isUnknownCommandError", () => {
  it("matches only the daemon's unknown-command wording", () => {
    expect(isUnknownCommandError("unknown command: graph.trace")).toBe(true);
    expect(isUnknownCommandError("timeout")).toBe(false);
    expect(isUnknownCommandError(undefined)).toBe(false);
  });
});

describe("probeStoreWritable", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-probe-"));
  });

  afterEach(() => {
    try {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("reports a writable directory and leaves no probe behind", () => {
    expect(probeStoreWritable(dir)).toBe("writable");
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(storeWriteDeniedNotice(dir)).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports a read-only directory as sandboxed",
    () => {
      fs.chmodSync(dir, 0o500);
      expect(probeStoreWritable(dir)).toBe("sandboxed");
      expect(storeWriteDeniedNotice(dir)).toBe(LEASE_DENIED_MESSAGE);
    },
  );

  it("prints the spawn notice at most once", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnStoreWriteDeniedOnce();
    warnStoreWriteDeniedOnce();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
