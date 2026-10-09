import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SafetyStopDiagnostics } from "../src/lib/utils/pressure-diagnostics";
import {
  latchSafetyStop,
  SAFETY_LATCH_NAME,
  safetyStopReason,
} from "../src/lib/utils/safety-latch";

describe("durable host safety stop", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-safety-unit-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true });
  });
  it("persists a private latch across repeated reads and does not overwrite its cause", () => {
    expect(safetyStopReason(root)).toBeNull();
    latchSafetyStop("critical\nkernel pressure", root);
    expect(safetyStopReason(root)).toBe("critical kernel pressure");
    const original = fs.readFileSync(
      path.join(root, SAFETY_LATCH_NAME),
      "utf8",
    );
    latchSafetyStop("later restart", root);
    expect(fs.readFileSync(path.join(root, SAFETY_LATCH_NAME), "utf8")).toBe(
      original,
    );
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, SAFETY_LATCH_NAME)).mode & 0o777).toBe(
      0o600,
    );
    expect(fs.readdirSync(root)).toEqual([SAFETY_LATCH_NAME]);
  });
  it("fails closed for corrupt, oversized and non-file markers", () => {
    const file = path.join(root, SAFETY_LATCH_NAME);
    fs.writeFileSync(file, "partial payload");
    expect(safetyStopReason(root)).toBe("unreadable safety stop");
    fs.writeFileSync(file, "x".repeat(8193));
    expect(safetyStopReason(root)).toBe("unverified safety stop");
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(safetyStopReason(root)).toBe("unverified safety stop");
  });
  it("does not trust a symlink marker", () => {
    fs.symlinkSync(
      path.join(root, "absent"),
      path.join(root, SAFETY_LATCH_NAME),
    );
    expect(safetyStopReason(root)).toBe("unverified safety stop");
  });
  it("persists bounded trigger evidence without retaining supplied payloads or replacing the first evidence", () => {
    const diagnostics = {
      source: "resource-admission",
      action: "reserve",
      policy: "critical-only",
      pid: 123,
      reservationKind: "worker",
      reservationMb: 1536,
      snapshot: {
        at: 100,
        completedAt: 120,
        memoryPressure: "critical",
        kernelPressure: "ok",
        kernelBytes: 1024,
        aggregateFootprintMb: null,
        physicalFreeMb: null,
        swapUsedMb: null,
        processes: ["private-process"],
        incompleteReasons: ["private-path"],
      },
      probes: {
        memoryInitial: {
          status: "known",
          memoryPressure: "critical",
          memoryLevel: 4,
          sampledAtMs: 101,
          durationMs: 2,
          outputBytes: 2,
          stdout: "private-query".repeat(10000),
        },
        memoryFinal: {
          status: "known",
          memoryPressure: "normal",
          sampledAtMs: 118,
          durationMs: 2,
          outputBytes: 2,
        },
      },
      argv: ["private-query"],
    } as unknown as SafetyStopDiagnostics;
    latchSafetyStop("critical", root, diagnostics);
    const file = path.join(root, SAFETY_LATCH_NAME),
      bytes = fs.readFileSync(file);
    expect(bytes.length).toBeLessThan(8192);
    const stored = JSON.parse(bytes.toString());
    expect(stored.diagnostics).toMatchObject({
      source: "resource-admission",
      action: "reserve",
      policy: "critical-only",
      pid: 123,
      reservationKind: "worker",
      reservationMb: 1536,
      snapshot: { memoryPressure: "critical" },
      probes: {
        memoryInitial: {
          memoryPressure: "critical",
          memoryLevel: 4,
          sampledAtMs: 101,
        },
        memoryFinal: { memoryPressure: "normal", sampledAtMs: 118 },
      },
    });
    expect(bytes.toString()).not.toContain("private-");
    expect(safetyStopReason(root)).toBe("critical");
    latchSafetyStop("later", root, { ...diagnostics, pid: 456 });
    expect(fs.readFileSync(file)).toEqual(bytes);
  });
  it("invalid optional diagnostics cannot prevent the stop", () => {
    const diagnostics = {
      get source() {
        throw Error("malformed optional data");
      },
    } as unknown as SafetyStopDiagnostics;
    latchSafetyStop("critical", root, diagnostics);
    expect(safetyStopReason(root)).toBe("critical");
    expect(
      JSON.parse(fs.readFileSync(path.join(root, SAFETY_LATCH_NAME), "utf8"))
        .diagnostics,
    ).toBeUndefined();
  });
  it("drops nonfinite measurements and unrecognized strings from optional evidence", () => {
    latchSafetyStop("critical", root, {
      source: "daemon-pressure",
      action: "heartbeat",
      policy: "strict",
      pid: 123,
      probes: {
        kernel: {
          status: "unknown",
          reason: "private-path",
          durationMs: Infinity,
          kernelBytes: 999,
          kernelPressure: "critical",
        },
      },
      reservationKind: "private-query",
      reservationMb: NaN,
    } as unknown as SafetyStopDiagnostics);
    const stored = JSON.parse(
      fs.readFileSync(path.join(root, SAFETY_LATCH_NAME), "utf8"),
    );
    expect(stored.diagnostics.probes.kernel).toEqual({ status: "unknown" });
    expect(JSON.stringify(stored)).not.toContain("private-");
  });
});
