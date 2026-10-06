import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
