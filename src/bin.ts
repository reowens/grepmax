#!/usr/bin/env node
// Entry point. Picks the gmax home before anything reads config.ts: a command
// aimed at a project under a secondary store's prefix (src/lib/utils/stores.ts)
// runs against that store, in-process, so the drive it lives on can always
// eject. Only Node built-ins and stores.ts may be imported here.
import * as fs from "node:fs";
import * as path from "node:path";
import { matchStore } from "./lib/utils/stores";

const DIR_ARG_COMMANDS = new Set(["add", "remove"]);

function optionValue(argv: string[], names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    for (const n of names) {
      if (a === n && argv[i + 1]) return argv[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

export function commandTarget(argv: string[], cwd: string): string {
  const explicit =
    optionValue(argv, ["--root", "--store"]) ??
    (argv[0] === "index" ? optionValue(argv, ["--path", "-p"]) : undefined) ??
    process.env.GMAX_STORE;
  if (explicit) return path.resolve(cwd, explicit);
  if (DIR_ARG_COMMANDS.has(argv[0])) {
    const positional = argv.slice(1).find((a) => !a.startsWith("-"));
    if (
      positional &&
      (positional.includes(path.sep) ||
        fs.existsSync(path.resolve(cwd, positional)))
    ) {
      return path.resolve(cwd, positional);
    }
  }
  return cwd;
}

function selectHome(): void {
  if (process.env.GMAX_HOME) return;
  const argv = process.argv.slice(2);
  const match = matchStore(commandTarget(argv, process.cwd()));
  if (match.kind === "primary") return;
  if (match.kind === "offline") {
    process.stderr.write(
      `gmax: this project's index lives on ${match.volume}, which is not mounted (store ${match.store.home}). Connect the drive and run the command again.\n`,
    );
    process.exit(2);
  }
  process.env.GMAX_HOME = match.store.home;
  // A secondary store never runs a daemon: nothing may hold the drive's files
  // open between commands, or the drive could not eject.
  process.env.GMAX_NO_AUTOSTART = "1";
  process.env.GMAX_SECONDARY_STORE = "1";
  seedConfig(match.store.home);
  alignCwdWithRegistry(match.store.home);
}

// Node reports the physical working directory, so a shell standing in
// ~/Development/packages/x (a symlink onto the drive) looks like
// /Volumes/External/dev/packages/x, while the store registered the path it was
// given. When the physical cwd sits inside a registered root's realpath,
// report the cwd in the registered form so project lookup finds it.
export function registeredForm(
  cwd: string,
  roots: string[],
  real: (p: string) => string = realpathOr,
): string | null {
  for (const root of roots) {
    const rootReal = real(root);
    const rel = path.relative(rootReal, cwd);
    if (rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel))) {
      return rel ? path.join(root, rel) : root;
    }
  }
  return null;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function alignCwdWithRegistry(home: string): void {
  let roots: string[];
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(home, "projects.json"), "utf-8"),
    ) as Array<{ root?: unknown }>;
    roots = parsed
      .map((p) => p.root)
      .filter((r): r is string => typeof r === "string");
  } catch {
    return;
  }
  const physical = process.cwd();
  const logical = registeredForm(physical, roots);
  if (logical && logical !== physical) process.cwd = () => logical;
}

// A new store embeds with the same model as the primary one.
function seedConfig(home: string): void {
  const target = path.join(home, "config.json");
  if (fs.existsSync(target)) return;
  const primary = path.join(process.env.HOME ?? "", ".gmax", "config.json");
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.copyFileSync(primary, target);
  } catch {
    // no primary config: the store starts from the defaults, as ~/.gmax did
  }
}

if (require.main === module) {
  selectHome();
  require("./index");
}
