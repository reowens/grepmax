import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { MODEL_IDS, PATHS } from "../config";
import { ensureGrammars } from "../lib/index/grammar-loader";
import { ensureSetup } from "../lib/setup/setup-helpers";
import { gracefulExit } from "../lib/utils/exit";

export const setup = new Command("setup")
  .description("One-time setup: download models and prepare osgrep")
  .action(async () => {
    console.log("osgrep Setup\n");

    try {
      await ensureSetup();
    } catch (error) {
      console.error("Setup failed:", error);
      process.exit(1);
    }

    // Show final status
    console.log("\nSetup Complete!\n");

    const modelIds = [MODEL_IDS.embed, MODEL_IDS.colbert];

    const checkDir = (name: string, p: string) => {
      const exists = fs.existsSync(p);
      const symbol = exists ? "✓" : "✗";
      console.log(`${symbol} ${name}: ${p}`);
    };

    checkDir("Global Root", PATHS.globalRoot);
    checkDir("Models", PATHS.models);
    checkDir("Grammars", PATHS.grammars);

    // Download Grammars
    console.log("\nChecking Tree-sitter Grammars...");
    await ensureGrammars();

    const modelStatuses = modelIds.map((id) => {
      const modelPath = path.join(PATHS.models, ...id.split("/"));
      return { id, path: modelPath, exists: fs.existsSync(modelPath) };
    });

    modelStatuses.forEach(({ id, exists }) => {
      const symbol = exists ? "✓" : "✗";
      console.log(`${symbol} Model: ${id}`);
    });

    // Check for skiplist.json and try to download if missing
    const colbertPath = path.join(
      PATHS.models,
      ...MODEL_IDS.colbert.split("/"),
    );
    const skiplistPath = path.join(colbertPath, "skiplist.json");
    if (fs.existsSync(skiplistPath)) {
      console.log(`✓ Skiplist found: ${skiplistPath}`);
    } else {
      console.log(`⚠ Skiplist missing, attempting to download...`);
      try {
        const url = `https://huggingface.co/${MODEL_IDS.colbert}/resolve/main/skiplist.json`;
        const response = await fetch(url);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          fs.writeFileSync(skiplistPath, Buffer.from(buffer));
          console.log(`✓ Skiplist downloaded successfully`);
        } else {
          console.log(
            `⚠ Skiplist download failed (HTTP ${response.status}), will use fallback`,
          );
          console.log(`   Expected at: ${skiplistPath}`);
        }
      } catch (error) {
        console.log(`⚠ Skiplist download failed, will use fallback`);
        console.log(
          `   Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        console.log(`   Expected at: ${skiplistPath}`);
      }
    }

    console.log(`\nosgrep is ready! You can now run:`);
    console.log(`   osgrep index              # Index your repository`);
    console.log(`   osgrep "search query"     # Search your code`);
    console.log(`   osgrep doctor             # Check health status`);

    await gracefulExit();
  });
