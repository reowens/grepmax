import { describe, expect, it } from "vitest";
import { shouldFallbackFromDaemonError } from "../src/commands/search-run";

describe("daemon search fallback", () => {
  it("falls back only when the daemon socket is absent or refused", () => {
    expect(shouldFallbackFromDaemonError("ENOENT")).toBe(true);
    expect(shouldFallbackFromDaemonError("ECONNREFUSED")).toBe(true);
  });

  it("does not fall back for live-daemon or ambiguous failures", () => {
    for (const error of [
      "timeout",
      "connection closed",
      "busy",
      "DAEMON_BUSY",
      "DAEMON_CLOSING",
      "rebuilding",
      "search_failed",
      "unknown command: search-v2",
      undefined,
    ]) {
      expect(shouldFallbackFromDaemonError(error)).toBe(false);
    }
  });
});
