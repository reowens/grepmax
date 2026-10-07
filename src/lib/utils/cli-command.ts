/** Find an explicit command after the root's --store option, without treating
 * its value (which can itself be a command name) as the command. Root help and
 * version flags retain their normal early-exit behavior. */
export function explicitCommand(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--store") {
      if (argv[i + 1] === undefined) return undefined;
      i++;
    } else if (arg.startsWith("--store=")) {
    } else if (arg === "--") {
      return argv[i + 1];
    } else {
      return arg.startsWith("-") ? undefined : arg;
    }
  }
  return undefined;
}
