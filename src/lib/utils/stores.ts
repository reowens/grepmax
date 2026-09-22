import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Secondary stores: a project that lives on an external drive keeps its index
// on that drive. ~/.gmax/stores.json maps a path prefix to a gmax home:
//
//   { "stores": [{ "prefix": "/Volumes/External/dev/packages",
//                  "home": "/Volumes/External/dev/.gmax-store" }] }
//
// This module imports only Node built-ins because src/bin.ts runs it before
// config.ts loads: GMAX_HOME has to be set before PATHS is computed.

export interface StoreEntry {
  prefix: string;
  home: string;
}

export type StoreMatch =
  | { kind: "primary" }
  | { kind: "store"; store: StoreEntry }
  | { kind: "offline"; store: StoreEntry; volume: string };

export function storesFilePath(home = os.homedir()): string {
  return path.join(home, ".gmax", "stores.json");
}

export function readStores(file = storesFilePath()): StoreEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { stores?: unknown };
    if (!Array.isArray(parsed.stores)) return [];
    return parsed.stores.filter(
      (s): s is StoreEntry =>
        !!s &&
        typeof (s as StoreEntry).prefix === "string" &&
        typeof (s as StoreEntry).home === "string",
    );
  } catch {
    return [];
  }
}

// The volume a path lives on, for paths under /Volumes; null for the boot disk.
export function volumeOf(p: string): string | null {
  const parts = path.resolve(p).split(path.sep);
  return parts[1] === "Volumes" && parts[2]
    ? path.join("/Volumes", parts[2])
    : null;
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return (
    rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel))
  );
}

// A path behind a symlink (~/Development/packages -> /Volumes/External/...)
// matches through its realpath. When the drive is ejected the symlink dangles
// and realpath fails, so the link target is read directly to still name it.
function candidates(target: string): string[] {
  const out = new Set<string>([path.resolve(target), realOrResolved(target)]);
  let cur = path.resolve(target);
  const tail: string[] = [];
  while (cur !== path.dirname(cur)) {
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        const link = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
        out.add(path.join(link, ...tail.slice().reverse()));
        break;
      }
    } catch {
      // not there; keep walking up
    }
    tail.push(path.basename(cur));
    cur = path.dirname(cur);
  }
  return [...out];
}

export function matchStore(
  target: string,
  stores: StoreEntry[] = readStores(),
): StoreMatch {
  if (!stores.length) return { kind: "primary" };
  for (const cand of candidates(target)) {
    for (const store of stores) {
      if (!within(cand, path.resolve(store.prefix))) continue;
      const volume = volumeOf(store.home) ?? volumeOf(store.prefix);
      if (volume && !fs.existsSync(volume)) {
        return { kind: "offline", store, volume };
      }
      return { kind: "store", store };
    }
  }
  return { kind: "primary" };
}
