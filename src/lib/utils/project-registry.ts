/**
 * Global project registry — tracks all indexed projects for
 * cross-project search and dimension compatibility checking.
 *
 * Stored in ~/.gmax/projects.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";

export interface ProjectEntry {
  root: string;
  name: string;
  vectorDim: number;
  modelTier: string;
  embedMode: string;
  lastIndexed: string;
  chunkCount?: number;
}

const REGISTRY_PATH = path.join(PATHS.globalRoot, "projects.json");

function loadRegistry(): ProjectEntry[] {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
    return JSON.parse(raw) as ProjectEntry[];
  } catch {
    return [];
  }
}

function saveRegistry(entries: ProjectEntry[]): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(entries, null, 2)}\n`);
}

export function registerProject(entry: ProjectEntry): void {
  const entries = loadRegistry();
  const idx = entries.findIndex((e) => e.root === entry.root);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  saveRegistry(entries);
}

export function listProjects(): ProjectEntry[] {
  return loadRegistry();
}

export function getProject(root: string): ProjectEntry | undefined {
  return loadRegistry().find((e) => e.root === root);
}

export function removeProject(root: string): void {
  const entries = loadRegistry().filter((e) => e.root !== root);
  saveRegistry(entries);
}
