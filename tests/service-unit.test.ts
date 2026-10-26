import { describe, expect, it } from "vitest";
import { systemdServiceUnit } from "../src/lib/utils/service-unit";

function proc(environ: string[], cgroup: string) {
  return (file: string) => {
    if (file === "/proc/42/environ") return `${environ.join("\0")}\0`;
    if (file === "/proc/42/cgroup") return cgroup;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
}

describe("systemd service unit of a daemon PID", () => {
  it("names a user unit and its user restart command", () => {
    expect(
      systemdServiceUnit(
        42,
        proc(
          ["PATH=/usr/bin", "SYSTEMD_EXEC_PID=42"],
          "0::/user.slice/user-1000.slice/user@1000.service/app.slice/gmax.service\n",
        ),
      ),
    ).toEqual({
      name: "gmax.service",
      restart: "systemctl --user restart gmax.service",
    });
  });

  it("names a system unit without --user", () => {
    expect(
      systemdServiceUnit(
        42,
        proc(["SYSTEMD_EXEC_PID=42"], "0::/system.slice/gmax.service\n"),
      )?.restart,
    ).toBe("systemctl restart gmax.service");
  });

  it("ignores a daemon a CLI spawned inside another service", () => {
    expect(
      systemdServiceUnit(
        42,
        proc(
          ["SYSTEMD_EXEC_PID=7"],
          "0::/user.slice/user-1000.slice/user@1000.service/app.slice/hetchy-helper.service\n",
        ),
      ),
    ).toBeNull();
  });

  it("ignores a terminal scope and a host without /proc", () => {
    expect(
      systemdServiceUnit(
        42,
        proc(
          ["SYSTEMD_EXEC_PID=42"],
          "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-terminal-1.scope\n",
        ),
      ),
    ).toBeNull();
    expect(systemdServiceUnit(43, proc([], ""))).toBeNull();
  });
});
