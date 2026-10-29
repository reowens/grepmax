import { describe, expect, it } from "vitest";
import {
  AGENT_CHEATSHEET,
  SESSION_START_HINT,
  SESSION_START_PREFIX,
} from "../src/lib/help/agent-cheatsheet";

// Preserve the exported CLI reference shape. Session hooks now use the bounded
// repo-status helper so a generic cheatsheet cannot imply current-repo readiness.
describe("agent cheatsheet", () => {
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
