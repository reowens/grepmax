import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect ~/.gmax to a temp dir so the marker functions never touch the real
// home (or a running daemon's state). PATHS is computed from os.homedir() at
// config load, so this mock must be in place before daemon-client is imported.
const h = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => h.home };
});

import {
  clearDrainingMarker,
  isDaemonDraining,
  writeDrainingMarker,
} from "../src/lib/utils/daemon-client";

describe("daemon draining marker", () => {
  beforeEach(() => {
    h.home = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-drain-"));
    fs.mkdirSync(path.join(h.home, ".gmax"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(h.home, { recursive: true, force: true });
  });

  it("reports a live, freshly-marked PID as draining", () => {
    // process.pid is alive, so a fresh marker for it reads as draining.
    writeDrainingMarker(process.pid);
    expect(isDaemonDraining(process.pid)).toBe(true);
  });

  it("is false for a different PID than the marker names", () => {
    writeDrainingMarker(process.pid);
    expect(isDaemonDraining(process.pid + 1)).toBe(false);
  });

  it("is false once the marker is cleared", () => {
    writeDrainingMarker(process.pid);
    clearDrainingMarker();
    expect(isDaemonDraining(process.pid)).toBe(false);
  });

  it("is false when no marker exists", () => {
    expect(isDaemonDraining(process.pid)).toBe(false);
  });

  it("treats a stale marker (past the grace window) as not draining", () => {
    const markerPath = path.join(h.home, ".gmax", "daemon.draining");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() - 120_000 }),
    );
    expect(isDaemonDraining(process.pid)).toBe(false);
  });

  it("treats a marker for a dead PID as not draining", () => {
    const markerPath = path.join(h.home, ".gmax", "daemon.draining");
    // PID 2^31-1 is effectively never a live process.
    const deadPid = 2147483646;
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ pid: deadPid, ts: Date.now() }),
    );
    expect(isDaemonDraining(deadPid)).toBe(false);
  });
});
