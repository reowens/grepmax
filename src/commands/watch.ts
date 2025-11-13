import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import ora from "ora";
import { getJWTToken } from "../lib/auth";
import { isIgnoredByGit } from "../lib/git";
import { createMxbaiClient } from "../lib/mxbai";
import { ensureAuthenticated, initialSync, uploadFile } from "../utils";

export const watch = new Command("watch")
  .description("Watch for file changes")
  .action(async (_args, cmd) => {
    const options: { store: string } = cmd.optsWithGlobals();

    await ensureAuthenticated();

    try {
      const jwtToken = await getJWTToken();
      const mxbai = createMxbaiClient(jwtToken);

      const watchRoot = process.cwd();

      const spinner = ora({ text: "Indexing files..." }).start();
      let lastProcessed = 0;
      let lastUploaded = 0;
      let lastTotal = 0;
      try {
        try {
          await mxbai.stores.retrieve(options.store);
        } catch {
          await mxbai.stores.create({
            name: options.store,
            description:
              "MGrep store - Mixedbreads mulitmodal mulitlingual magic search",
          });
        }
        const result = await initialSync(
          mxbai,
          options.store,
          watchRoot,
          (info) => {
            lastProcessed = info.processed;
            lastUploaded = info.uploaded;
            lastTotal = info.total;
            const rel = info.filePath?.startsWith(watchRoot)
              ? path.relative(watchRoot, info.filePath)
              : (info.filePath ?? "");
            spinner.text = `Indexing files (${lastProcessed}/${lastTotal}) • uploaded ${lastUploaded} ${rel}`;
          },
        );
        spinner.succeed(
          `Initial sync complete (${result.processed}/${result.total}) • uploaded ${result.uploaded}`,
        );
      } catch (e) {
        spinner.fail("Initial upload failed");
        throw e;
      }

      console.log("Watching for file changes in", watchRoot);
      fs.watch(watchRoot, { recursive: true }, (eventType, rawFilename) => {
        const filename = rawFilename?.toString();
        if (!filename) {
          return;
        }
        const filePath = path.join(watchRoot, filename);
        console.log(`${eventType}: ${filePath}`);

        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) {
            return;
          }
        } catch {
          return;
        }

        if (isIgnoredByGit(filePath, watchRoot)) {
          return;
        }

        uploadFile(mxbai, options.store, filePath, filename).catch((err) => {
          console.error("Failed to upload changed file:", filePath, err);
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to start watcher:", message);
      process.exitCode = 1;
    }
  });
