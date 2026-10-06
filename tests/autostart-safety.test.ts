import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  safety: null as string | null,
  stat: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("node:fs", () => ({ lstatSync: h.stat }));
vi.mock("node:child_process", () => ({ spawn: h.spawn }));
vi.mock("../src/config", () => ({
  PATHS: {
    autostartDisabledFile: "/synthetic/autostart-disabled",
    sharedRoot: "/machine",
  },
}));
vi.mock("../src/lib/utils/safety-latch", () => ({
  safetyStopReason: () => h.safety,
}));
vi.mock("../src/lib/utils/log-rotate", () => ({ openRotatedLog: vi.fn() }));

import {
  autostartDisabledNotice,
  daemonStartDeniedReason,
  isAutostartDisabled,
} from "../src/lib/utils/autostart";
import {
  spawnDaemon,
  spawnDaemonProcess,
} from "../src/lib/utils/daemon-launcher";

describe("quarantine admission", () => {
  beforeEach(() => {
    h.safety = null;
    h.spawn.mockReset();
    h.stat.mockReset().mockImplementation(() => {
      throw Object.assign(Error("absent"), { code: "ENOENT" });
    });
    delete process.env.GMAX_NO_AUTOSTART;
  });
  it("admits only exact marker absence", () => {
    expect(daemonStartDeniedReason()).toBeNull();
    h.stat.mockImplementation(() => {
      throw Object.assign(Error("denied"), { code: "EACCES" });
    });
    expect(isAutostartDisabled()).toBe(true);
  });
  it("refuses an existing marker including a symlink", () => {
    h.stat.mockReturnValue({ isSymbolicLink: () => true });
    expect(daemonStartDeniedReason()).toContain("quarantined");
  });
  it("cannot evade machine quarantine by selecting another data root", async () => {
    h.stat.mockImplementation((file: string) => {
      if (file === "/machine/autostart-disabled") return {};
      throw Object.assign(Error("absent"), { code: "ENOENT" });
    });
    expect(isAutostartDisabled()).toBe(true);
    expect(await spawnDaemon()).toBeNull();
    await expect(spawnDaemonProcess()).rejects.toThrow("quarantined");
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it("keeps the critical stop visible without suggesting flag removal or local writes", () => {
    h.safety = "critical pressure";
    expect(autostartDisabledNotice()).toContain("Mutations remain blocked");
    expect(autostartDisabledNotice()).not.toContain("rm ");
    expect(autostartDisabledNotice()).not.toContain("running in-process");
  });
  it.each(["user", "safety"])(
    "both launcher entry points refuse %s quarantine without spawning",
    async (kind) => {
      if (kind === "safety") h.safety = "critical pressure";
      else h.stat.mockReturnValue({});
      expect(await spawnDaemon()).toBeNull();
      await expect(spawnDaemonProcess()).rejects.toThrow("gmax:");
      expect(h.spawn).not.toHaveBeenCalled();
    },
  );
});
