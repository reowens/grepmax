import { describe, expect, it } from "vitest";
import { formatIndexStateFooter } from "../src/lib/output/index-state-footer";

/**
 * Phase 6 — partial-index signal. The formatter is the whole user-visible
 * contract: it must stay silent at steady state and speak (machine-readably in
 * agent mode) only while the index is actually catching up.
 */

describe("formatIndexStateFooter", () => {
  it("returns null when there is no state to report", () => {
    expect(formatIndexStateFooter(undefined, { agent: true })).toBeNull();
    expect(formatIndexStateFooter(undefined, { agent: false })).toBeNull();
  });

  it("stays silent at steady state (not indexing)", () => {
    const settled = { indexing: false, pendingFiles: 0 };
    expect(formatIndexStateFooter(settled, { agent: true })).toBeNull();
    expect(formatIndexStateFooter(settled, { agent: false })).toBeNull();
  });

  it("emits a machine-readable footer with the count in agent mode", () => {
    const footer = formatIndexStateFooter(
      { indexing: true, pendingFiles: 142 },
      { agent: true },
    );
    expect(footer).toBe(
      "[index: syncing · ~142 files pending · results may be incomplete — retry for full coverage]",
    );
  });

  it("omits the count when it is unknown (initial sync, pendingFiles 0)", () => {
    const footer = formatIndexStateFooter(
      { indexing: true, pendingFiles: 0 },
      { agent: true },
    );
    expect(footer).toBe(
      "[index: syncing · results may be incomplete — retry for full coverage]",
    );
    // no stray "~0 files"
    expect(footer).not.toContain("0 files");
  });

  it("uses a human-readable warning shape in non-agent mode", () => {
    expect(
      formatIndexStateFooter({ indexing: true, pendingFiles: 7 }, { agent: false }),
    ).toBe("⚠️  Index still syncing (~7 files pending) — results may be incomplete.");
    expect(
      formatIndexStateFooter({ indexing: true, pendingFiles: 0 }, { agent: false }),
    ).toBe("⚠️  Index still syncing — results may be incomplete.");
  });
});
