import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WatcherRecoveryTracker } from "../src/lib/index/watcher-recovery";
import { formatWatcherRecovery } from "../src/lib/output/index-state-footer";

const gap = new Error(
  "Events were dropped by the FSEvents client. File system must be re-scanned.",
);

describe("bounded watcher recovery evidence", () => {
  it("covers only the gap prefix present at scan start, independently of terminal errors", () => {
    const tracker = new WatcherRecoveryTracker();
    tracker.error(gap);
    const first = tracker.beginScan();
    tracker.error(gap);
    tracker.error(new Error("backend stopped /private/source query=secret"));
    tracker.finishScan(first, "complete");
    expect(tracker.snapshot()).toMatchObject({
      gapCount: 2,
      terminalErrorCount: 1,
      coveredGapCount: 1,
      outstandingGapCount: 1,
      reconciliationNeeded: true,
      lastScan: {
        id: 1,
        outcome: "complete",
        gapCountAtStart: 1,
        terminalErrorCountAtStart: 0,
      },
    });
    const later = tracker.beginScan();
    tracker.finishScan(later, "complete");
    expect(tracker.snapshot()).toMatchObject({
      coveredGapCount: 2,
      outstandingGapCount: 0,
      reconciliationNeeded: false,
      lastCompleteScan: { id: 2, terminalErrorCountAtStart: 1 },
    });
    expect(JSON.stringify(tracker.snapshot())).not.toContain("secret");
  });

  it.each(["incomplete", "aborted", "failed"] as const)(
    "retains prior complete evidence and outstanding gaps after a %s scan",
    (outcome) => {
      const tracker = new WatcherRecoveryTracker();
      const first = tracker.beginScan();
      tracker.finishScan(first, "complete");
      tracker.error(gap);
      const next = tracker.beginScan();
      tracker.finishScan(next, outcome);
      expect(tracker.snapshot()).toMatchObject({
        coveredGapCount: 0,
        outstandingGapCount: 1,
        reconciliationNeeded: true,
        lastCompleteScan: { id: 1, outcome: "complete" },
        lastScan: { id: 2, outcome },
      });
    },
  );

  it("does not invent a scan or coverage for refusal before execution", () => {
    const tracker = new WatcherRecoveryTracker();
    tracker.error(gap);
    tracker.attemptFailed(false, false);
    expect(tracker.snapshot()).toMatchObject({
      scanCount: 0,
      coveredGapCount: 0,
      outstandingGapCount: 1,
      reconciliationNeeded: true,
      lastAttemptFailure: { scanStarted: false },
    });
    expect(tracker.snapshot().lastScan).toBeUndefined();
  });

  it("keeps incomplete initial reconciliation visible without an event gap", () => {
    const tracker = new WatcherRecoveryTracker();
    tracker.finishScan(tracker.beginScan(), "incomplete");
    expect(tracker.snapshot()).toMatchObject({
      gapCount: 0,
      outstandingGapCount: 0,
      reconciliationNeeded: true,
    });
  });

  it("summarizes the attached policy without revealing paths, and returns detached snapshots", () => {
    const tracker = new WatcherRecoveryTracker();
    const policy = JSON.stringify([
      "private-artifacts",
      "**/build/**",
      "/^private-file$/",
    ]);
    tracker.attached(policy);
    expect(tracker.snapshot().exclusions).toEqual({
      attached: true,
      literalCount: 1,
      filterCount: 2,
      fingerprint: createHash("sha256").update(policy).digest("hex"),
    });
    const snapshot = tracker.snapshot();
    snapshot.exclusions!.literalCount = 500;
    tracker.detached();
    expect(tracker.snapshot().exclusions).toMatchObject({
      attached: false,
      literalCount: 1,
    });
    expect(JSON.stringify(tracker.snapshot())).not.toContain(
      "private-artifacts",
    );
    expect(formatWatcherRecovery(tracker.snapshot())).toContain(
      "exclusions=detached:1+2:",
    );
    expect(formatWatcherRecovery(undefined)).toBeNull();
  });

  it("retains constant-size evidence through repeated gaps and scans", () => {
    const tracker = new WatcherRecoveryTracker();
    for (let i = 0; i < 1000; i++) {
      tracker.error(gap);
      tracker.finishScan(tracker.beginScan(), "complete");
    }
    const snapshot = tracker.snapshot();
    snapshot.lastScan!.outcome = "failed";
    expect(tracker.snapshot().lastScan?.outcome).toBe("complete");
    expect(tracker.snapshot().gapCount).toBe(1000);
    expect(Buffer.byteLength(JSON.stringify(tracker.snapshot()))).toBeLessThan(
      2048,
    );
  });
});
