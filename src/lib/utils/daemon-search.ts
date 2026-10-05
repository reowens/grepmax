import { validateMaxPerFile } from "../search/per-file";
import { sendDaemonCommand } from "./daemon-client";

/** An old live daemon must not silently ignore a request-scoped override. */
export async function sendSearchCommand(
  command: Parameters<typeof sendDaemonCommand>[0],
  options?: Parameters<typeof sendDaemonCommand>[1],
) {
  const maxPerFile = validateMaxPerFile(command.maxPerFile);
  if (maxPerFile !== undefined) {
    const ping = await sendDaemonCommand({ cmd: "ping" }, options);
    if (!ping.ok) return ping;
    if (
      (ping.capabilities as Record<string, unknown> | undefined)
        ?.perFileSearch !== 1
    ) {
      return {
        ok: false,
        error: "unsupported per-file retrieval control",
        hint: "run gmax watch restart with the updated CLI",
      };
    }
  }
  return sendDaemonCommand(command, options);
}
