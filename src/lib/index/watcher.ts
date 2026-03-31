import * as watcher from "@parcel/watcher";
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

// Ignore patterns for @parcel/watcher (micromatch globs + directory names).
// Directory names are matched at any depth automatically.
export const WATCHER_IGNORE_GLOBS: string[] = [
  "node_modules",
  ".git",
  ".gmax",
  "dist",
  "build",
  "out",
  "target",
  "__pycache__",
  "coverage",
  "venv",
  ".next",
  "lancedb",
  ".*", // dotfiles
];

export async function startWatcher(opts: WatcherOptions): Promise<WatcherHandle> {
  const { projectRoot } = opts;
  const wtag = `watch:${projectRoot.split("/").pop()}`;

  const processor = new ProjectBatchProcessor(opts);

  const subscription = await watcher.subscribe(
    projectRoot,
    (err, events) => {
      if (err) {
        console.error(`[${wtag}] Watcher error:`, err);
        return;
      }
      for (const event of events) {
        processor.handleFileEvent(
          event.type === "delete" ? "unlink" : "change",
          event.path,
        );
      }
    },
    { ignore: WATCHER_IGNORE_GLOBS },
  );

  return {
    close: async () => {
      await processor.close();
      await subscription.unsubscribe();
    },
  };
}
