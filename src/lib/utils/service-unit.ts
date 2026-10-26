import * as fs from "node:fs";

export interface ServiceUnit {
  name: string;
  /** The command that restarts the unit, e.g. `systemctl --user restart gmax.service`. */
  restart: string;
}

/**
 * The systemd service whose main process is `pid`, or null. systemd sets
 * SYSTEMD_EXEC_PID on the process it starts, so a daemon a CLI spawned from
 * inside some other service does not count: only a unit's own ExecStart.
 * A unit carries the host's CPU limits, so gmax must never restart its daemon
 * from outside it. Linux only; elsewhere /proc is absent and this is null.
 */
export function systemdServiceUnit(
  pid: number,
  read: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): ServiceUnit | null {
  let environ: string;
  let cgroup: string;
  try {
    environ = read(`/proc/${pid}/environ`);
    cgroup = read(`/proc/${pid}/cgroup`);
  } catch {
    return null;
  }
  const execPid = environ
    .split("\0")
    .find((entry) => entry.startsWith("SYSTEMD_EXEC_PID="))
    ?.slice("SYSTEMD_EXEC_PID=".length);
  if (execPid !== String(pid)) return null;
  const unified = cgroup.split("\n").find((line) => line.startsWith("0::"));
  if (!unified) return null;
  const segments = unified.slice(3).split("/").filter(Boolean);
  const name = segments[segments.length - 1];
  if (!name?.endsWith(".service")) return null;
  const user = segments.some((segment) => /^user@\d+\.service$/.test(segment));
  return {
    name,
    restart: `systemctl ${user ? "--user " : ""}restart ${name}`,
  };
}

/** Exit status a unit-managed daemon uses to ask systemd for a fresh start. */
export const SERVICE_RECYCLE_EXIT_CODE = 75;
