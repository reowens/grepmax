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

  // A catchup after an FSEvents drop queues the whole project — 10k+ files
  // clearing at ~0.0s per batch with 0 reindexed. Reporting that as "results may
  // be incomplete" trains agents to distrust and retry correct answers.
  it("reports re-verification as current, not incomplete, in agent mode", () => {
    const footer = formatIndexStateFooter(
      { indexing: true, pendingFiles: 10943, verifying: true },
      { agent: true },
    );
    expect(footer).toBe(
      "[index: verifying ~10943 unchanged files · results current]",
    );
    expect(footer).not.toContain("incomplete");
    expect(footer).not.toContain("retry");
  });

  it("reports re-verification as current in non-agent mode", () => {
    expect(
      formatIndexStateFooter(
        { indexing: true, pendingFiles: 10943, verifying: true },
        { agent: false },
      ),
    ).toBe("Index verifying 10943 unchanged files — results are current.");
    expect(
      formatIndexStateFooter(
        { indexing: true, pendingFiles: 1, verifying: true },
        { agent: false },
      ),
    ).toBe("Index verifying 1 unchanged file — results are current.");
  });

  it("still warns when there is real outstanding work", () => {
    const footer = formatIndexStateFooter(
      { indexing: true, pendingFiles: 10943, verifying: false },
      { agent: true },
    );
    expect(footer).toContain("results may be incomplete");
  });

  it("treats an absent verifying flag as the incomplete case", () => {
    const footer = formatIndexStateFooter(
      { indexing: true, pendingFiles: 42 },
      { agent: true },
    );
    expect(footer).toContain("results may be incomplete");
  });

  it("stays silent at steady state even if verifying is set", () => {
    expect(
      formatIndexStateFooter(
        { indexing: false, pendingFiles: 0, verifying: true },
        { agent: true },
      ),
    ).toBeNull();
  });

  it("uses a human-readable warning shape in non-agent mode", () => {
    expect(
      formatIndexStateFooter(
        { indexing: true, pendingFiles: 7 },
        { agent: false },
      ),
    ).toBe(
      "⚠️  Index still syncing (~7 files pending) — results may be incomplete.",
    );
    expect(
      formatIndexStateFooter(
        { indexing: true, pendingFiles: 0 },
        { agent: false },
      ),
    ).toBe("⚠️  Index still syncing — results may be incomplete.");
  });
});
