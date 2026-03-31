import * as path from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { MetaCache } from "../store/meta-cache";
import type { VectorDB } from "../store/vector-db";
import { ProjectBatchProcessor } from "./batch-processor";

export interface WatcherHandle {
  close: () => Promise<void>;
}

export interface WatcherOptions {
  projectRoot: string;
  vectorDb: VectorDB;
  metaCache: MetaCache;
  dataDir: string;
  onReindex?: (files: number, durationMs: number) => void;
}

// Chokidar ignored — must exclude heavy directories to keep FD count low.
// On macOS, chokidar uses FSEvents (single FD) but falls back to fs.watch()
// (one FD per directory) if FSEvents isn't available or for some subdirs.
export const WATCHER_IGNORE_PATTERNS: Array<string | RegExp> = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.gmax/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/__pycache__/**",
  "**/coverage/**",
  "**/venv/**",
  "**/.next/**",
  "**/lancedb/**",
  /(^|[/\\])\../, // dotfiles
];

export function startWatcher(opts: WatcherOptions): WatcherHandle {
  const { projectRoot } = opts;
  const wtag = `watch:${path.basename(projectRoot)}`;

  const processor = new ProjectBatchProcessor(opts);

  // macOS: FSEvents is a single-FD kernel API — no EMFILE risk and no polling.
  // Linux: inotify is event-driven but uses one FD per watch; fall back to
  //        polling for monorepos to avoid hitting ulimit.
  // Override with GMAX_WATCH_POLL=1 to force polling on any platform.
  const forcePoll = process.env.GMAX_WATCH_POLL === "1";
  const usePoll = forcePoll || process.platform !== "darwin";

  const watcher: FSWatcher = watch(projectRoot, {
    ignored: WATCHER_IGNORE_PATTERNS,
    ignoreInitial: true,
    persistent: true,
    ...(usePoll
      ? { usePolling: true, interval: 5000, binaryInterval: 10000 }
      : {}),
  });

  watcher.on("error", (err) => {
    console.error(`[${wtag}] Watcher error:`, err);
  });

  watcher.on("add", (p) => processor.handleFileEvent("change", p));
  watcher.on("change", (p) => processor.handleFileEvent("change", p));
  watcher.on("unlink", (p) => processor.handleFileEvent("unlink", p));

  return {
    close: async () => {
      await processor.close();
      await watcher.close();
    },
  };
}
