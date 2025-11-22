import * as path from "node:path";
import chokidar from "chokidar";
import { Command } from "commander";
import { createFileSystem, createStore } from "../lib/context";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/sync-helpers";
import { initialSync, uploadFile, MetaStore } from "../utils";

export const watch = new Command("watch")
  .option(
    "-d, --dry-run",
    "Dry run the watch process (no actual file syncing)",
    false,
  )
  .description("Watch for file changes")
  .action(async (_args, cmd) => {
    const options: { store: string; dryRun: boolean } = cmd.optsWithGlobals();

    try {
      const store = await createStore();
      const fileSystem = createFileSystem({
        ignorePatterns: ["*.lock", "*.bin", "*.ipynb", "*.pyc"],
      });
      const watchRoot = process.cwd();
      const metaStore = new MetaStore();

      const { spinner, onProgress } = createIndexingSpinner(
        watchRoot,
        "Indexing Local Index...",
      );
      try {
        try {
          await store.retrieve(options.store);
        } catch {
          await store.create({
            name: options.store,
            description: "osgrep local index",
          });
        }
        const result = await initialSync(
          store,
          fileSystem,
          options.store,
          watchRoot,
          options.dryRun,
          onProgress,
          metaStore
        );
        spinner.succeed(
          `Initial sync complete (${result.processed}/${result.total}) • uploaded ${result.uploaded}`,
        );
        if (options.dryRun) {
          console.log(
            formatDryRunSummary(result, {
              actionDescription: "found",
              includeTotal: true,
            }),
          );
          return;
        }
      } catch (e) {
        spinner.fail("Initial upload failed");
        throw e;
      }

      console.log("Watching for file changes in", watchRoot);
      fileSystem.loadOsgrepignore(watchRoot);
      const debounceTimers = new Map<string, NodeJS.Timeout>();
      const scheduleUpload = (filePath: string) => {
        const existing = debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);
        debounceTimers.set(
          filePath,
          setTimeout(() => {
            debounceTimers.delete(filePath);
            if (fileSystem.isIgnored(filePath, watchRoot)) {
              return;
            }
            const filename = path.basename(filePath);
            uploadFile(store, options.store, filePath, filename, metaStore).catch((err) => {
              console.error("Failed to upload changed file:", filePath, err);
            });
          }, 300),
        );
      };

      const handleUnlink = async (filePath: string) => {
        if (fileSystem.isIgnored(filePath, watchRoot)) {
          return;
        }
        try {
          await store.deleteFile(options.store, filePath);
          metaStore.delete(filePath);
          await metaStore.save();
        } catch (err) {
          console.error("Failed to delete removed file:", filePath, err);
        }
      };

      const watcher = chokidar.watch(watchRoot, {
        ignoreInitial: true,
      });

      watcher
        .on("add", scheduleUpload)
        .on("change", scheduleUpload)
        .on("unlink", handleUnlink)
        .on("error", (err: unknown) => {
          console.error("Watcher error:", err);
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to start watcher:", message);
      process.exitCode = 1;
    }
  });
