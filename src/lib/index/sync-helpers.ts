import { relative } from "node:path";
import ora, { type Ora } from "ora";

interface IndexingSpinner {
  spinner: Ora;
  onProgress: (info: InitialSyncProgress) => void;
}

export interface InitialSyncProgress {
  processed: number;
  indexed: number;
  total: number;
  filePath?: string;
}

interface ProgressTracker {
  startTime: number;
  lastProcessed: number;
  estimatedTimeRemaining(): string;
  update(processed: number, total: number): void;
}

export interface InitialSyncResult {
  processed: number;
  indexed: number;
  total: number;
}

/**
 * Converts an absolute `filePath` into a path relative to `root` when possible,
 * keeping absolute fallbacks for paths outside the repo.
 *
 * @param root The root directory of the repository
 * @param filePath The path to the file to format
 * @returns The formatted path
 */
function formatRelativePath(root: string, filePath?: string): string {
  if (!filePath) {
    return "";
  }
  return filePath.startsWith(root) ? relative(root, filePath) : filePath;
}

/**
 * Creates a progress tracker that estimates time remaining based on processing rate.
 */
function createProgressTracker(): ProgressTracker {
  const startTime = Date.now();
  let lastProcessed = 0;

  return {
    startTime,
    lastProcessed,
    update(processed: number, _total: number) {
      this.lastProcessed = processed;
    },
    estimatedTimeRemaining(): string {
      if (this.lastProcessed === 0) return "";

      const elapsed = Date.now() - this.startTime;
      const rate = this.lastProcessed / elapsed; // files per ms

      if (rate === 0) return "";

      return "";
    },
  };
}

/**
 * Formats milliseconds into a human-readable time string.
 */
function formatTime(ms: number): string {
  const seconds = Math.ceil(ms / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Creates a shared spinner + progress callback pair that keeps the CLI UI
 * consistent across commands running `initialSync`.
 *
 * @param root The root directory of the repository
 * @param label The label to use for the spinner
 * @returns The spinner and progress callback pair
 */
export function createIndexingSpinner(
  root: string,
  label = "Indexing files...",
): IndexingSpinner {
  const spinner = ora({ text: label }).start();
  const tracker = createProgressTracker();

  return {
    spinner,
    onProgress(info) {
      tracker.update(info.processed, info.total);

      // Handle pre-indexing phases (before total is known or special messages)
      if (info.filePath && (
        info.filePath.startsWith('Scanning...') ||
        info.filePath.startsWith('Checking index...') ||
        info.filePath.startsWith('Processing') ||
        info.filePath.startsWith('Checking for changes')
      )) {
        spinner.text = info.filePath;
        if (process.env.OSGREP_DEBUG_INDEX === "1") {
          console.log(`[progress] ${info.filePath}`);
        }
        return;
      }

      const rel = formatRelativePath(root, info.filePath);
      const fileSuffix = rel ? ` • ${rel}` : "";

      // Calculate estimated time remaining
      let timeSuffix = "";
      if (info.processed > 0 && info.processed < info.total && info.total > 0) {
        const elapsed = Date.now() - tracker.startTime;
        const rate = info.processed / elapsed; // files per ms
        const remaining = info.total - info.processed;
        const estimatedMs = remaining / rate;

        if (estimatedMs > 0 && Number.isFinite(estimatedMs)) {
          timeSuffix = ` • ~${formatTime(estimatedMs)} remaining`;
        }
      }

      spinner.text = `Indexing files (${info.processed}/${info.total})${timeSuffix}${fileSuffix}`;
    },
  };
}

/**
 * Produces a single-line summary describing what a dry-run sync would have done.
 *
 * @param result The result of the initial sync
 * @param actionDescription The description of the action
 * @param includeTotal Whether to include the total number of files
 * @returns The formatted summary
 */
export function formatDryRunSummary(
  result: InitialSyncResult,
  {
    actionDescription,
    includeTotal = false,
  }: { actionDescription: string; includeTotal?: boolean },
): string {
  const totalSuffix = includeTotal ? " in total" : "";
  return `Dry run: ${actionDescription} ${result.processed} files${totalSuffix}, would have indexed ${result.indexed} changed or new files`;
}
