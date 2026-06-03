import { describe, expect, it } from "vitest";
import {
  AGENT_CHEATSHEET,
  SESSION_START_HINT,
  SESSION_START_PREFIX,
} from "../src/lib/help/agent-cheatsheet";

// The SessionStart hook (plugins/grepmax/hooks/start.js) require()s the
// compiled form of this module and reads SESSION_START_HINT. These tests lock
// that contract so a rename/shape change can't silently fall back to the
// hook's inline copy and drift.
describe("agent cheatsheet (shared with SessionStart hook)", () => {
  it("exports SESSION_START_HINT as a non-empty string", () => {
    expect(typeof SESSION_START_HINT).toBe("string");
    expect(SESSION_START_HINT.length).toBeGreaterThan(0);
  });

  it("composes the hint as prefix + cheatsheet", () => {
    expect(SESSION_START_HINT).toBe(
      `${SESSION_START_PREFIX}\n\n${AGENT_CHEATSHEET}`,
    );
  });

  it("covers the core command groups and recovery hints", () => {
    for (const marker of [
      "Find:",
      "Understand:",
      "Survey:",
      "gmax peek",
      "gmax trace",
      "Scope flags:",
      "Recovery:",
    ]) {
      expect(AGENT_CHEATSHEET).toContain(marker);
    }
  });
});
