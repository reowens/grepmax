import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { PATHS } from "../../config";

const USER_UNIT = "gmax.service";

/**
 * An installed user unit owns the default home's daemon, even when it is
 * stopped, disabled or masked. Do not discover unrelated services or redirect
 * a secondary store into the primary service. lstat retains masked symlinks.
 */
export function installedUserDaemonService({
  platform = process.platform,
  home = os.homedir(),
  dataRoot = PATHS.globalRoot,
  configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
} = {}): string | null {
  if (
    platform !== "linux" ||
    dataRoot !== path.join(home, ".gmax") ||
    process.env.GMAX_SECONDARY_STORE === "1"
  )
    return null;
  if (!path.isAbsolute(configHome))
    throw new Error(
      "Cannot verify Gmax user service: XDG_CONFIG_HOME must be absolute",
    );
  try {
    fs.lstatSync(path.join(configHome, "systemd/user", USER_UNIT));
    return USER_UNIT;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Cannot verify ${USER_UNIT}; refusing standalone startup`);
    return null;
  }
}

/** Start only through the existing unit; failures must never detach a daemon. */
export async function startUserDaemonService(
  name: string,
  options: { readOnly?: boolean } = {},
): Promise<number> {
  if (name !== USER_UNIT) throw new Error("Unsupported Gmax user unit");
  // A normal unit cannot accept CLI flags. Starting it and pausing afterwards
  // could index first, including under a read-only quarantine request.
  if (options.readOnly)
    throw new Error(
      `${name} owns daemon startup; configure read-only service with the host operator before starting it`,
    );
  const run = promisify(execFile);
  const execOptions = {
    timeout: 5000,
    maxBuffer: 64 * 1024,
    encoding: "utf8" as const,
  };
  try {
    // job-mode=fail: a start never replaces a queued stop, so a CLI call that
    // finds no daemon cannot cancel someone's `systemctl stop` and restart the
    // unit under it. An active or starting unit still succeeds as before.
    await run(
      "systemctl",
      ["--user", "--no-ask-password", "start", "--job-mode=fail", name],
      execOptions,
    );
    const { stdout } = await run(
      "systemctl",
      ["--user", "show", "--property=MainPID", "--value", name],
      execOptions,
    );
    const pid = Number(stdout.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("the service has no running MainPID");
    return pid;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    try {
      const { stdout } = await run(
        "systemctl",
        ["--user", "show", "--property=ActiveState", "--value", name],
        execOptions,
      );
      if (stdout.trim() === "deactivating")
        message = `${name} is stopping; a start would cancel that stop`;
    } catch {}
    throw new Error(
      `Failed to start ${name}: ${message}; no standalone daemon was started. Inspect: systemctl --user status ${name}`,
    );
  }
}
