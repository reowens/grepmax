import { createHash } from "node:crypto";
import { isFSEventsGap } from "./watcher-errors";

export interface WatcherRecoveryState {
  gapCount: number;
  terminalErrorCount: number;
  coveredGapCount: number;
  outstandingGapCount: number;
  reconciliationNeeded: boolean;
  lastGapAt?: number;
  lastTerminalErrorAt?: number;
  scanCount: number;
  lastScan?: WatcherScan;
  lastCompleteScan?: WatcherScan;
  lastAttemptFailure?: { at: number; scanStarted: boolean; aborted: boolean };
  exclusions?: {
    attached: boolean;
    literalCount: number;
    filterCount: number;
    fingerprint: string;
  };
}

interface WatcherScan {
  id: number;
  startedAt: number;
  gapCountAtStart: number;
  terminalErrorCountAtStart: number;
  finishedAt?: number;
  outcome: "running" | "complete" | "incomplete" | "aborted" | "failed";
}

/** Fixed-size, process/lifecycle-local evidence. A completed walk covers only
 * errors already observed when it began; queued ingestion is reported separately. */
export class WatcherRecoveryTracker {
  private gapCount = 0;
  private terminalErrorCount = 0;
  private coveredGapCount = 0;
  private coveredTerminalErrorCount = 0;
  private lastGapAt?: number;
  private lastTerminalErrorAt?: number;
  private scanCount = 0;
  private scanIncomplete = false;
  private lastScan?: WatcherScan;
  private lastCompleteScan?: WatcherScan;
  private lastAttemptFailure?: WatcherRecoveryState["lastAttemptFailure"];
  private exclusions?: WatcherRecoveryState["exclusions"];

  error(error: Error): void {
    if (isFSEventsGap(error)) {
      this.gapCount++;
      this.lastGapAt = Date.now();
    } else {
      this.terminalErrorCount++;
      this.lastTerminalErrorAt = Date.now();
    }
  }

  beginScan(): WatcherScan {
    const scan: WatcherScan = {
      id: ++this.scanCount,
      startedAt: Date.now(),
      gapCountAtStart: this.gapCount,
      terminalErrorCountAtStart: this.terminalErrorCount,
      outcome: "running",
    };
    this.lastScan = scan;
    return scan;
  }

  finishScan(
    scan: WatcherScan,
    outcome: Exclude<WatcherScan["outcome"], "running">,
  ): void {
    scan.finishedAt = Date.now();
    scan.outcome = outcome;
    if (outcome === "complete") {
      this.scanIncomplete = false;
      this.coveredGapCount = Math.max(
        this.coveredGapCount,
        scan.gapCountAtStart,
      );
      this.coveredTerminalErrorCount = Math.max(
        this.coveredTerminalErrorCount,
        scan.terminalErrorCountAtStart,
      );
      this.lastCompleteScan = { ...scan };
    } else this.scanIncomplete = true;
  }

  attemptFailed(scanStarted: boolean, aborted: boolean): void {
    this.scanIncomplete = true;
    this.lastAttemptFailure = { at: Date.now(), scanStarted, aborted };
  }

  attached(policy: string): void {
    // The subscription helper returns the exact accepted policy, including its
    // fallback. Summarize that value; never rediscover directories for health.
    const patterns = JSON.parse(policy) as string[];
    const literalCount = patterns.filter(
      (pattern) => !pattern.startsWith("/") && !pattern.includes("*"),
    ).length;
    this.exclusions = {
      attached: true,
      literalCount,
      filterCount: patterns.length - literalCount,
      fingerprint: createHash("sha256").update(policy).digest("hex"),
    };
  }

  detached(): void {
    if (this.exclusions) this.exclusions.attached = false;
  }

  snapshot(): WatcherRecoveryState {
    return {
      gapCount: this.gapCount,
      terminalErrorCount: this.terminalErrorCount,
      coveredGapCount: this.coveredGapCount,
      outstandingGapCount: this.gapCount - this.coveredGapCount,
      reconciliationNeeded:
        this.scanIncomplete ||
        this.lastScan?.outcome === "running" ||
        this.gapCount > this.coveredGapCount ||
        this.terminalErrorCount > this.coveredTerminalErrorCount,
      lastGapAt: this.lastGapAt,
      lastTerminalErrorAt: this.lastTerminalErrorAt,
      scanCount: this.scanCount,
      lastScan: this.lastScan && { ...this.lastScan },
      lastCompleteScan: this.lastCompleteScan && { ...this.lastCompleteScan },
      lastAttemptFailure: this.lastAttemptFailure && {
        ...this.lastAttemptFailure,
      },
      exclusions: this.exclusions && { ...this.exclusions },
    };
  }
}
