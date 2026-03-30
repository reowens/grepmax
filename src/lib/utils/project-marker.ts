/**
 * Per-project marker file (.gmax.json) — signals that a directory
 * has been explicitly added to the gmax index.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const MARKER_NAME = ".gmax.json";

interface MarkerConfig {
  version: number;
  addedAt: string;
}

export function createMarker(projectRoot: string): void {
  const markerPath = path.join(projectRoot, MARKER_NAME);
  const config: MarkerConfig = {
    version: 1,
    addedAt: new Date().toISOString(),
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function removeMarker(projectRoot: string): void {
  const markerPath = path.join(projectRoot, MARKER_NAME);
  try {
    fs.unlinkSync(markerPath);
  } catch {
    // Already gone — fine
  }
}

export function hasMarker(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, MARKER_NAME));
}

export function readMarker(projectRoot: string): MarkerConfig | null {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, MARKER_NAME), "utf-8");
    return JSON.parse(raw) as MarkerConfig;
  } catch {
    return null;
  }
}
