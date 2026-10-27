import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: Object.assign(
    vi.fn(() => {
      throw Error("Real subprocess forbidden");
    }),
    {
      [Symbol.for("nodejs.util.promisify.custom")]: h.run,
    },
  ),
}));

import {
  installedUserDaemonService,
  startUserDaemonService,
} from "../src/lib/utils/service-startup";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-service-"));
  vi.stubEnv("GMAX_SECONDARY_STORE", "0");
  h.run.mockReset().mockResolvedValue({ stdout: "42\n", stderr: "" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});
function discover(
  configHome = path.join(home, ".config"),
  platform: NodeJS.Platform = "linux",
  dataRoot = path.join(home, ".gmax"),
) {
  return installedUserDaemonService({ home, platform, dataRoot, configHome });
}
function install(
  name: string,
  configHome = path.join(home, ".config"),
  masked = false,
) {
  const dir = path.join(configHome, "systemd/user");
  fs.mkdirSync(dir, { recursive: true });
  if (masked) fs.symlinkSync("/dev/null", path.join(dir, name));
  else
    fs.writeFileSync(
      path.join(dir, name),
      "[Service]\nExecStart=gmax watch --daemon\n",
    );
}

describe("installed Gmax user service discovery", () => {
  it("leaves a host with no installed unit on the standalone route", () => {
    expect(discover()).toBeNull();
    expect(h.run).not.toHaveBeenCalled();
  });
  it.each(["gmax.service", "hetchy-gmax.service"])(
    "recognizes %s regardless of active state",
    (name) => {
      install(name);
      expect(discover()).toBe(name);
      expect(h.run).not.toHaveBeenCalled();
    },
  );
  it("uses XDG config and retains a mask as service ownership", () => {
    const config = path.join(home, "xdg");
    install("gmax.service", config, true);
    vi.stubEnv("XDG_CONFIG_HOME", config);
    expect(
      installedUserDaemonService({
        home,
        platform: "linux",
        dataRoot: path.join(home, ".gmax"),
      }),
    ).toBe("gmax.service");
  });
  it("does not redirect macOS, another store, or a secondary-store launch", () => {
    install("gmax.service");
    expect(discover(undefined, "darwin")).toBeNull();
    expect(discover(undefined, "linux", path.join(home, "other"))).toBeNull();
    vi.stubEnv("GMAX_SECONDARY_STORE", "1");
    expect(discover()).toBeNull();
    expect(h.run).not.toHaveBeenCalled();
  });
  it("refuses ambiguous installed owners", () => {
    install("gmax.service");
    install("hetchy-gmax.service");
    expect(() => discover()).toThrow("Both");
  });
  it("refuses unreadable discovery rather than assuming no service", () => {
    vi.mocked(fs.lstatSync).mockImplementationOnce(() => {
      throw Object.assign(Error("denied"), { code: "EACCES" });
    });
    expect(() => discover()).toThrow("refusing standalone startup");
  });
});

describe("managed startup without detached fallback", () => {
  it("starts the unit without a shell, with a deadline, then returns its MainPID", async () => {
    expect(await startUserDaemonService("hetchy-gmax.service")).toBe(42);
    expect(h.run.mock.calls).toEqual([
      [
        "systemctl",
        ["--user", "--no-ask-password", "start", "hetchy-gmax.service"],
        { timeout: 5000, maxBuffer: 65536, encoding: "utf8" },
      ],
      [
        "systemctl",
        [
          "--user",
          "show",
          "--property=MainPID",
          "--value",
          "hetchy-gmax.service",
        ],
        { timeout: 5000, maxBuffer: 65536, encoding: "utf8" },
      ],
    ]);
  });
  it.each([
    "masked unit",
    "user bus unavailable",
    "timed out",
    "executable missing",
  ])("refuses %s with no replacement", async (reason) => {
    h.run.mockRejectedValueOnce(Error(reason));
    await expect(startUserDaemonService("gmax.service")).rejects.toThrow(
      "no standalone daemon was started",
    );
    expect(h.run).toHaveBeenCalledTimes(1);
  });
  it.each(["0\n", "not-a-pid\n", "-1\n"])(
    "does not claim success for MainPID %s",
    async (stdout) => {
      h.run
        .mockResolvedValueOnce({ stdout: "" })
        .mockResolvedValueOnce({ stdout });
      await expect(startUserDaemonService("gmax.service")).rejects.toThrow(
        "no running MainPID",
      );
    },
  );
  it("does not start normal service for a read-only request", async () => {
    await expect(
      startUserDaemonService("gmax.service", { readOnly: true }),
    ).rejects.toThrow("configure read-only service");
    expect(h.run).not.toHaveBeenCalled();
  });
});
