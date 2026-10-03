import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";
import { type GlobalConfig, readGlobalConfig } from "../index/index-config";
import { listProjects, type ProjectEntry } from "./project-registry";
import { matchStore, readStores, type StoreEntry, volumeOf } from "./stores";

export interface StoreInventory {
  home: string;
  prefixes: string[];
  state: "mounted" | "offline" | "uninitialized" | "error";
  volume: string | null;
  projects: ProjectEntry[];
  error?: string;
}

/** Metadata only: an offline store is never opened or recreated. */
export function storeInventory(
  stores: StoreEntry[] = readStores(),
): StoreInventory[] {
  const homes = new Map<string, StoreInventory>();
  for (const store of stores) {
    const home = path.resolve(store.home);
    const prior = homes.get(home);
    if (prior) {
      prior.prefixes.push(store.prefix);
      continue;
    }
    const volume = volumeOf(home) ?? volumeOf(store.prefix);
    const item: StoreInventory = {
      home,
      prefixes: [store.prefix],
      volume,
      state: "mounted",
      projects: [],
    };
    if (volume && !fs.existsSync(volume)) item.state = "offline";
    else if (!fs.existsSync(home)) item.state = "uninitialized";
    else {
      try {
        item.projects = listProjects(home);
      } catch (error) {
        item.state = "error";
        item.error = String(error);
      }
    }
    homes.set(home, item);
  }
  return [...homes.values()];
}

export interface StoreContext {
  home: string;
  root: string;
  secondary: boolean;
  projects: ProjectEntry[];
  config: GlobalConfig;
  lancedbDir: string;
  lmdbPath: string;
}

const contexts = new AsyncLocalStorage<StoreContext>();
export function currentStoreContext(): StoreContext | undefined {
  return contexts.getStore();
}

export function withStoreContext<T>(
  root: string,
  fn: (context: StoreContext) => Promise<T>,
): Promise<T> {
  const match = matchStore(root);
  if (match.kind === "offline") {
    throw new Error(
      `gmax: this project's index lives on ${match.volume}, which is not mounted (store ${match.store.home}). Connect the drive and run the command again.`,
    );
  }
  const home =
    match.kind === "store" ? path.resolve(match.store.home) : PATHS.globalRoot;
  const context: StoreContext = {
    home,
    root,
    secondary:
      match.kind === "store" || process.env.GMAX_SECONDARY_STORE === "1",
    projects: listProjects(home),
    config: readGlobalConfig(home),
    lancedbDir: path.join(home, "lancedb"),
    lmdbPath: path.join(home, "cache", "meta.lmdb"),
  };
  return contexts.run(context, () => fn(context));
}
