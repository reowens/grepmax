import { describe, expect, it } from "vitest";
import { shouldFallbackFromDaemonError } from "../src/commands/search-run";
import { classifyDaemonError } from "../src/lib/utils/store-access";

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

  it("does not fall back when the sandbox denied the socket", () => {
    // These used to surface as `Daemon search failed: EPERM`. They are now a
    // distinct class: refuse with the settings hint, never open the store.
    for (const error of ["EPERM", "EACCES", "EROFS"]) {
      expect(shouldFallbackFromDaemonError(error)).toBe(false);
      expect(classifyDaemonError(error)).toBe("sandboxed");
    }
  });

  it("agrees with the shared classifier on the fallback set", () => {
    for (const error of ["ENOENT", "ECONNREFUSED"]) {
      expect(classifyDaemonError(error)).toBe("no-daemon");
    }
    expect(classifyDaemonError("timeout")).toBe("daemon-error");
  });
});
