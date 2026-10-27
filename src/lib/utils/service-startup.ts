import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { PATHS } from "../../config";

const USER_UNITS = ["gmax.service", "hetchy-gmax.service"];

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
  const found: string[] = [];
  for (const name of USER_UNITS) {
    try {
      fs.lstatSync(path.join(configHome, "systemd/user", name));
      found.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(`Cannot verify ${name}; refusing standalone startup`);
    }
  }
  if (found.length > 1)
    throw new Error(
      "Both gmax.service and hetchy-gmax.service are installed; select one before starting Gmax",
    );
  return found[0] ?? null;
}

/** Start only through the existing unit; failures must never detach a daemon. */
export async function startUserDaemonService(
  name: string,
  options: { readOnly?: boolean } = {},
): Promise<number> {
  if (!USER_UNITS.includes(name)) throw new Error("Unsupported Gmax user unit");
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
    await run(
      "systemctl",
      ["--user", "--no-ask-password", "start", name],
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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to start ${name}: ${message}; no standalone daemon was started. Inspect: systemctl --user status ${name}`,
    );
  }
}
